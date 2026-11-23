<?php

declare(strict_types=1);

namespace Kinglet\Transport;

/**
 * Sends one NDJSON batch to Kinglet. Implementations never throw: a network
 * failure comes back as a result with a null status and an error message.
 */
interface Transport
{
    public function send(string $url, string $token, string $body, float $timeout): Result;
}
