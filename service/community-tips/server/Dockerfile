# SubVibe community tips — static Go binary (pure-Go SQLite, no cgo) on distroless.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tips .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /tips /tips
USER nonroot
ENV ADDR=:8080 DB_PATH=/data/tips.db
EXPOSE 8080
ENTRYPOINT ["/tips"]
