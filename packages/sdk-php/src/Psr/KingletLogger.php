<?php

declare(strict_types=1);

namespace Kinglet\Psr;

use Kinglet\Client;
use Kinglet\Level;
use Psr\Log\AbstractLogger;

/**
 * A PSR-3 logger that sends to Kinglet. Needs `psr/log` (^2 or ^3).
 *
 * `{placeholder}` tokens in the message are replaced from the context, as
 * PSR-3 describes, and the whole context becomes the event's fields. A
 * Throwable under the `exception` key keeps its class, message, location, and
 * a short trace.
 *
 *     $logger = new KingletLogger(Client::fromEnvironment(['service' => 'api']));
 *     $logger->warning('Payment {id} retried', ['id' => 'pay_42', 'attempt' => 2]);
 */
final class KingletLogger extends AbstractLogger
{
    public function __construct(private readonly Client $client)
    {
    }

    public function client(): Client
    {
        return $this->client;
    }

    /** @param array<array-key, mixed> $context */
    public function log($level, string|\Stringable $message, array $context = []): void
    {
        $name = is_string($level) ? $level : (is_scalar($level) ? (string) $level : 'info');

        $this->client->log(Level::fromName($name), self::interpolate((string) $message, $context), $context);
    }

    /** @param array<array-key, mixed> $context */
    private static function interpolate(string $message, array $context): string
    {
        if (!str_contains($message, '{')) {
            return $message;
        }

        return (string) preg_replace_callback(
            '/\{([A-Za-z0-9_.]+)\}/',
            static function (array $match) use ($context): string {
                $value = $context[$match[1]] ?? null;

                return match (true) {
                    $value === null => $match[0],
                    is_scalar($value), $value instanceof \Stringable => (string) $value,
                    $value instanceof \DateTimeInterface => $value->format(\DateTimeInterface::RFC3339),
                    default => '[' . get_debug_type($value) . ']',
                };
            },
            $message,
        );
    }
}
