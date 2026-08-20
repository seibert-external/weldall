# syntax=docker/dockerfile:1

FROM nginxinc/nginx-unprivileged:1.28-alpine

ENV NGINX_ENVSUBST_FILTER=^WELDALL_UPSTREAM$

COPY --chmod=755 docker-entrypoint.d/05-validate-upstream.sh /docker-entrypoint.d/05-validate-upstream.sh
COPY default.conf.template /etc/nginx/templates/default.conf.template

RUN WELDALL_UPSTREAM=https://127.0.0.1:1 /docker-entrypoint.sh nginx -t

EXPOSE 8080
