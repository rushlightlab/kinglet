<?php

declare(strict_types=1);

namespace Kinglet;

use Kinglet\Transport\HttpTransport;
use Kinglet\Transport\Transport;

/**
 * Batching log client for Kinglet.
 *
 * Events are buffered in memory and sent as one NDJSON request when the batch
 * fills, when `flushInterval` seconds have passed since the last send (checked
 * on each log call, for long-running workers), and when the script ends. PHP
 * has no background thread, so a send happens inside the log call or the
 * shutdown handler; short timeouts keep that bounded.
 *
 * Logging never throws. A failed batch stays buffered (up to `maxBuffered`
 * events, oldest dropped first) and is retried later, with automatic sends
 * backing off from 1 s to 60 s so an unreachable Kinglet doesn't slow every
 * log call down; a batch
 * Kinglet rejects (a bad key, for example) is dropped. Either way `onError`
 * is called, or, without one, a throttled line goes to PHP's error log.
 *
 * With an empty `url` or `token` the client is disabled and every call is a
 * no-op, so an app without Kinglet configured keeps running.
 */
final class Client
{
    public const VERSION = '0.4.0';

    /** The server accepts up to 10,000 events per batch; stay well under it. */
    public const MAX_EVENTS_PER_REQUEST = 5000;

    /** The server's body limit is 8 MB. */
    private const MAX_BODY_BYTES = 7_500_000;

    private const ERROR_REPORT_INTERVAL = 60.0;

    /** After a failed send, automatic sends wait 1 s, then 2 s, … up to 60 s. */
    private const MIN_BACKOFF = 1.0;

    private const MAX_BACKOFF = 60.0;

    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES
        | JSON_UNESCAPED_UNICODE
        | JSON_INVALID_UTF8_SUBSTITUTE
        | JSON_PRESERVE_ZERO_FRACTION
        | JSON_PARTIAL_OUTPUT_ON_ERROR;

    /** @var list<array<string, mixed>> */
    private array $buffer = [];

    private readonly string $endpoint;

    private readonly bool $enabled;

    private readonly Transport $transport;

    /** @var (\Closure(KingletException): void)|null */
    private readonly ?\Closure $onError;

    private float $lastFlush;

    private float $lastErrorReport = 0.0;

    /** No automatic send before this time (epoch seconds). */
    private float $retryAt = 0.0;

    private float $backoff = 0.0;

    private bool $flushing = false;

    private bool $closed = false;

    /**
     * @param string $url Kinglet base URL, e.g. https://logs.example.com
     * @param string $token Project API key (kl_…) with the ingest scope
     * @param string|null $service Tag every event with this service
     * @param string|null $env Tag every event with this environment
     * @param int $batchSize Send when this many events are buffered (1–5000)
     * @param float $flushInterval Also send when this many seconds passed since the last send
     * @param int $maxBuffered Most events kept while Kinglet is unreachable
     * @param float $timeout Seconds one request may take
     * @param bool $flushOnShutdown Send what's left when the script ends
     * @param (callable(KingletException): void)|null $onError Called when a batch fails
     */
    public function __construct(
        string $url,
        private readonly string $token,
        private readonly ?string $service = null,
        private readonly ?string $env = null,
        private readonly int $batchSize = 100,
        private readonly float $flushInterval = 5.0,
        private readonly int $maxBuffered = 10_000,
        private readonly float $timeout = 2.0,
        bool $flushOnShutdown = true,
        ?callable $onError = null,
        ?Transport $transport = null,
    ) {
        $this->endpoint = rtrim(trim($url), '/') . '/v1/events';
        $this->enabled = trim($url) !== '' && trim($token) !== '';
        $this->transport = $transport ?? new HttpTransport();
        $this->onError = $onError === null ? null : \Closure::fromCallable($onError);
        $this->lastFlush = microtime(true);

        if ($flushOnShutdown && $this->enabled) {
            register_shutdown_function([$this, 'close']);
        }
    }

    /**
     * A client configured from KINGLET_URL and KINGLET_KEY (and optionally
     * KINGLET_SERVICE and KINGLET_ENV). Disabled if either required one is unset.
     *
     * @param array<string, mixed> $options Any other constructor argument, by name
     */
    public static function fromEnvironment(array $options = []): self
    {
        $read = static fn (string $name): ?string => ($value = getenv($name)) === false || $value === ''
            ? null
            : $value;

        return new self(...[
            'url' => $read('KINGLET_URL') ?? '',
            'token' => $read('KINGLET_KEY') ?? '',
            'service' => $read('KINGLET_SERVICE'),
            'env' => $read('KINGLET_ENV'),
            ...$options,
        ]);
    }

    public function enabled(): bool
    {
        return $this->enabled;
    }

    /** @param array<array-key, mixed> $fields */
    public function trace(string|\Stringable $message, array $fields = []): void
    {
        $this->log(Level::Trace, $message, $fields);
    }

    /** @param array<array-key, mixed> $fields */
    public function debug(string|\Stringable $message, array $fields = []): void
    {
        $this->log(Level::Debug, $message, $fields);
    }

    /** @param array<array-key, mixed> $fields */
    public function info(string|\Stringable $message, array $fields = []): void
    {
        $this->log(Level::Info, $message, $fields);
    }

    /** @param array<array-key, mixed> $fields */
    public function warn(string|\Stringable $message, array $fields = []): void
    {
        $this->log(Level::Warn, $message, $fields);
    }

    /** @param array<array-key, mixed> $fields */
    public function error(string|\Stringable $message, array $fields = []): void
    {
        $this->log(Level::Error, $message, $fields);
    }

    /** @param array<array-key, mixed> $fields */
    public function fatal(string|\Stringable $message, array $fields = []): void
    {
        $this->log(Level::Fatal, $message, $fields);
    }

    /**
     * @param Level|string $level A Level, or a Kinglet/PSR-3 level name
     * @param array<array-key, mixed> $fields Structured data; filter on it with `field.<key>`
     * @param \DateTimeInterface|null $time When it happened; defaults to now
     */
    public function log(
        Level|string $level,
        string|\Stringable $message,
        array $fields = [],
        ?\DateTimeInterface $time = null,
    ): void {
        if (!$this->enabled || $this->closed) {
            return;
        }

        try {
            $this->buffer[] = $this->event($level, $message, $fields, $time);

            // Bound memory while Kinglet is unreachable: newest events win.
            $overflow = count($this->buffer) - ($this->maxBuffered + $this->batchSize());

            if ($overflow > 0) {
                array_splice($this->buffer, 0, $overflow + $this->batchSize());
            }

            $now = microtime(true);
            $due = count($this->buffer) >= $this->batchSize()
                || $now - $this->lastFlush >= $this->flushInterval;

            if ($due && $now >= $this->retryAt) {
                $this->flush();
            }
        } catch (\Throwable $error) {
            $this->report(new KingletException('kinglet: could not record an event: ' . $error->getMessage()));
        }
    }

    /** Events waiting to be sent. */
    public function pending(): int
    {
        return count($this->buffer);
    }

    /**
     * Sends everything buffered now. Returns true when the buffer is empty
     * afterwards; false when a batch failed and was kept for the next flush.
     */
    public function flush(): bool
    {
        if (!$this->enabled || $this->flushing) {
            return $this->buffer === [];
        }

        $this->flushing = true;
        $this->lastFlush = microtime(true);

        try {
            while ($this->buffer !== []) {
                [$body, $count] = $this->encodeBatch();
                $result = $this->transport->send($this->endpoint, $this->token, $body, $this->timeout);

                if ($result->ok()) {
                    array_splice($this->buffer, 0, $count);
                    $this->backoff = 0.0;
                    $this->retryAt = 0.0;

                    continue;
                }

                $reason = $result->status === null
                    ? ($result->error ?? 'network error')
                    : 'HTTP ' . $result->status . ($result->body !== '' ? ': ' . substr($result->body, 0, 200) : '');

                if (!$result->retryable()) {
                    // Sending it again would fail the same way.
                    array_splice($this->buffer, 0, $count);
                    $this->report(new KingletException("kinglet: batch rejected, dropped {$count} events: {$reason}", $result->status, $count));

                    continue;
                }

                $this->backoff = min(self::MAX_BACKOFF, max(self::MIN_BACKOFF, $this->backoff * 2));
                $this->retryAt = microtime(true) + $this->backoff;
                $this->report(new KingletException("kinglet: log delivery failed, will retry: {$reason}", $result->status, $count));

                return false;
            }

            return true;
        } catch (\Throwable $error) {
            $this->report(new KingletException('kinglet: flush failed: ' . $error->getMessage()));

            return false;
        } finally {
            $this->flushing = false;
        }
    }

    /** Sends what's left and stops accepting events. Safe to call more than once. */
    public function close(): void
    {
        if ($this->closed) {
            return;
        }

        $this->flush();
        $this->closed = true;
    }

    private function batchSize(): int
    {
        return max(1, min($this->batchSize, self::MAX_EVENTS_PER_REQUEST));
    }

    /**
     * @param array<array-key, mixed> $fields
     * @return array<string, mixed>
     */
    private function event(Level|string $level, string|\Stringable $message, array $fields, ?\DateTimeInterface $time): array
    {
        $text = (string) $message;
        $resolved = $level instanceof Level ? $level : Level::fromName($level);
        $ts = $time === null
            ? (int) floor(microtime(true) * 1000)
            : (int) $time->format('Uv');

        $event = [
            'ts' => $ts,
            'level' => $resolved->value,
            // Kinglet requires a non-empty message.
            'message' => trim($text) === '' ? '(empty message)' : $text,
        ];

        if ($this->service !== null && $this->service !== '') {
            $event['service'] = $this->service;
        }

        if ($this->env !== null && $this->env !== '') {
            $event['env'] = $this->env;
        }

        if ($fields !== []) {
            // An object, even for list-shaped input: Kinglet's fields are a JSON object.
            $event['fields'] = (object) Fields::normalize($fields);
        }

        return $event;
    }

    /**
     * The NDJSON body for the next request and how many buffered events it
     * holds: at most MAX_EVENTS_PER_REQUEST, and under the body size limit.
     *
     * @return array{string, int}
     */
    private function encodeBatch(): array
    {
        $lines = [];
        $bytes = 0;

        foreach ($this->buffer as $index => $event) {
            if ($index >= self::MAX_EVENTS_PER_REQUEST) {
                break;
            }

            $line = json_encode($event, self::JSON_FLAGS);

            if ($line === false) {
                $line = (string) json_encode([
                    'ts' => $event['ts'],
                    'level' => $event['level'],
                    'message' => '(unencodable event)',
                ], self::JSON_FLAGS);
            }

            if ($lines !== [] && $bytes + strlen($line) + 1 > self::MAX_BODY_BYTES) {
                break;
            }

            $lines[] = $line;
            $bytes += strlen($line) + 1;
        }

        return [implode("\n", $lines), count($lines)];
    }

    private function report(KingletException $error): void
    {
        if ($this->onError !== null) {
            try {
                ($this->onError)($error);
            } catch (\Throwable) {
                // An error handler must not break the app either.
            }

            return;
        }

        $now = microtime(true);

        if ($now - $this->lastErrorReport < self::ERROR_REPORT_INTERVAL) {
            return;
        }

        $this->lastErrorReport = $now;
        error_log($error->getMessage());
    }
}
