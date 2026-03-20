require('dotenv').config();
const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Hardcoded simple API key for MVP - later connect to DB/Redis (RDS)
const VALID_API_KEYS = (process.env.API_KEYS || "demo-key").split(',');

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Support large JSON payloads
app.use(morgan('combined')); // Log requests

const NodeCache = require('node-cache');
// Cache keys for 5 minutes (300 seconds) to avoid LemonSqueezy rate limits and reduce latency
const licenseCache = new NodeCache({ stdTTL: 300 });

// Minimal auth middleware
const authMiddleware = async (req, res, next) => {
    // Client can provide API key via Header or Query Param
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    
    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized: Missing API Key' });
    }

    // 1. Support hardcoded dev/demo keys first
    if (VALID_API_KEYS.includes(apiKey)) {
        return next();
    }

    // 2. Check Local Cache (RAM)
    const cachedStatus = licenseCache.get(apiKey);
    if (cachedStatus === 'valid') return next();
    if (cachedStatus === 'invalid') return res.status(401).json({ error: 'Unauthorized: Invalid or expired API Key' });

    // 3. Verify via LemonSqueezy API
    try {
        const lsRes = await axios.post('https://api.lemonsqueezy.com/v1/licenses/validate', {
            license_key: apiKey
        }, {
            headers: { 'Accept': 'application/json' },
            validateStatus: () => true
        });

        if (lsRes.status === 200 && lsRes.data.valid) {
            // BẢO MẬT CẤP CAO: Phải check xem Key này có ĐÚNG là mua từ Shop của bạn không!
            // Đề phòng khách lấy Key mua từ Shop LemonSqueezy của người khác để xài chùa hệ thống này.
            const expectedStoreId = process.env.LEMON_STORE_ID;
            if (expectedStoreId && String(lsRes.data.meta.store_id) !== String(expectedStoreId)) {
                licenseCache.set(apiKey, 'invalid', 60); // Cache failure
                return res.status(403).json({ error: 'Forbidden: Valid Key but belongs to a different Store' });
            }

            licenseCache.set(apiKey, 'valid'); // Cache success for 5 mins
            return next();
        } else {
            licenseCache.set(apiKey, 'invalid', 60); // Cache failure for 1 minute
            return res.status(401).json({ 
                error: 'Unauthorized: Invalid or expired API Key from LemonSqueezy', 
                ls_error: lsRes.data.error || 'Key not mapped' 
            });
        }
    } catch (e) {
        console.error('LemonSqueezy Verification Error:', e.message);
        return res.status(500).json({ error: 'Failed to verify API Key' });
    }
};

// Health check endpoints for VPS checking/monitoring
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Core endpoint: /proxy
app.post('/proxy', authMiddleware, async (req, res) => {
    try {
        const { target_url, method = 'GET', headers = {}, body = null } = req.body;

        if (!target_url) {
            return res.status(400).json({ error: 'target_url is required' });
        }

        // Exclude host header from payload to avoid conflicts when forwarding
        if (headers['host']) delete headers['host'];

        // === SMART RETRY LOGIC ===
        const maxRetries = req.body.max_retries || 3;
        const baseDelayMs = req.body.base_delay_ms || 1000;
        
        let attempt = 0;
        let response = null;
        let finalErrorPayload = null;
        
        while (attempt <= maxRetries) {
            try {
                response = await axios({
                    url: target_url,
                    method: method,
                    headers: headers,
                    data: body,
                    // Chỉ ném lỗi (văng vào catch để Retry) nếu API đích sập (50x) hoặc rớt mạng.
                    // Lỗi 40x (Sai pass, thiếu param) thì là lỗi do Khách, không cần Retry.
                    validateStatus: (status) => status < 500
                });
                break; // Thành công! Cắt vòng lặp.
                
            } catch (error) {
                attempt++;
                finalErrorPayload = {
                    status: error.response?.status || 504,
                    message: error.message,
                    data: error.response?.data || null
                };

                if (attempt > maxRetries) break; // Hết lượt

                // Tính toán độ trễ theo Hàm mũ (Exponential Backoff): 1s, 2s, 4s...
                const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
                console.warn(`[Anti-Fail] 🔴 Lỗi ${finalErrorPayload.status} tại ${target_url}. Thử lại (${attempt}/${maxRetries}) sau ${delayMs}ms...`);
                
                // Tạm dừng (Sleep) server 1 lúc trước khi thử lại
                await new Promise(res => setTimeout(res, delayMs));
            }
        }

        // Trả kết quả cuối cùng cho khách
        if (response) {
            res.status(response.status).json({
                success: true,
                anti_fail_report: { retries_used: attempt },
                status: response.status,
                headers: response.headers,
                data: response.data
            });
        } else {
            console.error(`[Anti-Fail] 💀 Thất bại hoàn toàn ${target_url} sau ${maxRetries} lần Retry.`);
            res.status(finalErrorPayload.status).json({
                success: false,
                anti_fail_report: { retries_used: maxRetries, status: 'FAILED' },
                error: 'Target API persistently failing (50x/Timeout)',
                details: finalErrorPayload
            });
        }

    } catch (error) {
        console.error('Proxy Error:', error.message);
        res.status(500).json({ error: 'Failed to process proxy request', details: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy Gateway running at http://localhost:${PORT}`);
    console.log(`🔑 Accepted API Keys: ${VALID_API_KEYS.join(', ')}`);
});
