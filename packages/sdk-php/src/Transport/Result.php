<?php

declare(strict_types=1);

namespace Kinglet\Transport;

/** The outcome of one ingest request. */
final class Result
{
    public function __construct(
        /** HTTP status, or null when the request never got a response. */
        public readonly ?int $status,
        public readonly string $body = '',
        public readonly ?string $error = null,
    ) {
    }

    public function ok(): bool
    {
        return $this->status !== null && $this->status >= 200 && $this->status < 300;
    }

    /**
     * Whether sending the same batch again could succeed: network errors,
     * rate limits, and server errors. A 4xx (bad key, bad payload) won't.
     */
    public function retryable(): bool
    {
        return $this->status === null || $this->status === 429 || $this->status >= 500;
    }
}
