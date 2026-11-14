FROM golang:1.27-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /app/server ./cmd/server

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 mayfly \
 && mkdir -p /data/media && chown mayfly:mayfly /data/media && chmod 700 /data/media
COPY --from=builder /app/server /app/server
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/app/server"]
