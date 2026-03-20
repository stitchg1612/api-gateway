# Use minimal Node.js Alpine base image
FROM node:18-alpine

# Setup app directory
WORKDIR /app

# Install dependencies first (leverage Docker cache)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source code
COPY . .

# Expose proxy port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
