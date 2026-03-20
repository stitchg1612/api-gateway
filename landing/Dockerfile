FROM nginx:alpine
# Xóa cấu hình mặc định của NGINX
RUN rm -rf /etc/nginx/conf.d/default.conf
# Copy Router cấu hình mới
COPY default.conf /etc/nginx/conf.d/
# Copy giao diện HTML thành file tạm (.template)
COPY index.html /tmp/index.html
COPY index.css /usr/share/nginx/html/index.css

EXPOSE 80

# Thế biến môi trường (DOMAIN_NAME) vào HTML trước khi chạy Nginx
CMD envsubst '${DOMAIN_NAME}' < /tmp/index.html > /usr/share/nginx/html/index.html && nginx -g "daemon off;"
