#!/usr/bin/env bash

        install_nginx() {
            if ! command -v nginx &>/dev/null; then
                echo "📥 Installing Nginx..."
                sudo apt update && sudo apt install -y nginx || error_exit "Nginx install failed"
            fi

            # Clean up conflicting configs
            sudo find /etc/nginx/sites-available /etc/nginx/sites-enabled -type f 2>/dev/null | while read -r file; do
                if grep -q "server_name meet.bornwithwealth.com" "$file" 2>/dev/null; then
                    if [[ "$file" != "/etc/nginx/sites-available/bww-recording-app" ]]; then
                        sudo rm -f "$file"
                    fi
                fi
            done
            sudo rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/bww-recording-app 2>/dev/null || true

            # Ensure include directive exists
            if ! grep -q '/etc/nginx/sites-enabled/\*' /etc/nginx/nginx.conf; then
                sudo sed -i '/http[[:space:]]*{/,/}/ { /^[[:space:]]*}[[:space:]]*$/i\    include /etc/nginx/sites-enabled/*;
}' /etc/nginx/nginx.conf
            fi

            # Write Nginx config
            sudo tee /etc/nginx/sites-available/bww-recording-app > /dev/null << 'NGINX_EOF'
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

upstream bww_recording {
    server 127.0.0.1:4000 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name record.bornwithwealth.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name record.bornwithwealth.com;

    ssl_certificate /etc/letsencrypt/live/bornwithwealth.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bornwithwealth.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
   # add_header Content-Security-Policy "default-src 'self' https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; connect-src 'self' wss: https:;" always;

    root /home/recording-app/app;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    location /socket.io/ {
        proxy_pass http://bww_recording;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 300s;
    }

   
    location /recordings/ {
        client_max_body_size 10M;
        proxy_pass http://bww_recording/recordings/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/v1 {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://bww_recording/api/v1;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass_header Set-Cookie;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 5M;
    }

    location ~ /\. {
        deny all;
    }
    
    location ~ ^/(\.env|config/|\.git) {
        deny all;
    }
}
NGINX_EOF

            sudo ln -sf /etc/nginx/sites-available/bww-recording-app /etc/nginx/sites-enabled/bww-recording-app
            sudo nginx -t && sudo systemctl reload nginx && sudo systemctl enable nginx
        }

install_nginx
