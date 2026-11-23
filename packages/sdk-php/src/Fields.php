<?php

declare(strict_types=1);

namespace Kinglet;

/**
 * Turns arbitrary PHP context into JSON-safe event fields.
 *
 * Exceptions keep their class, message, code, location, and a short trace;
 * dates become ISO 8601 strings; objects use JsonSerializable or __toString
 * when they have one. Depth and trace length are capped so one event stays
 * well under the server's 32 KB fields limit.
 *
 * @internal
 */
final class Fields
{
    private const MAX_DEPTH = 6;

    private const MAX_TRACE_CHARS = 4000;

    private const MAX_STRING_CHARS = 8000;

    /**
     * @param array<array-key, mixed> $context
     * @return array<string, mixed>
     */
    public static function normalize(array $context): array
    {
        $fields = [];

        foreach ($context as $key => $value) {
            $fields[(string) $key] = self::value($value, 0);
        }

        return $fields;
    }

    /** @return array<string, mixed> */
    public static function exception(\Throwable $error, int $depth = 0): array
    {
        $fields = [
            'class' => $error::class,
            'message' => self::truncate($error->getMessage()),
            'code' => $error->getCode(),
            'file' => $error->getFile(),
            'line' => $error->getLine(),
            'trace' => self::truncate($error->getTraceAsString(), self::MAX_TRACE_CHARS),
        ];

        $previous = $error->getPrevious();

        if ($previous !== null && $depth < 2) {
            $fields['previous'] = self::exception($previous, $depth + 1);
        }

        return $fields;
    }

    private static function value(mixed $value, int $depth): mixed
    {
        if ($value === null || is_bool($value) || is_int($value)) {
            return $value;
        }

        if (is_float($value)) {
            // JSON has no NaN or Infinity.
            return match (true) {
                is_nan($value) => 'NaN',
                is_infinite($value) => $value > 0 ? 'Infinity' : '-Infinity',
                default => $value,
            };
        }

        if (is_string($value)) {
            return self::truncate($value);
        }

        if ($depth >= self::MAX_DEPTH) {
            return '[depth limit]';
        }

        if (is_array($value)) {
            $out = [];

            foreach ($value as $key => $item) {
                $out[$key] = self::value($item, $depth + 1);
            }

            return $out;
        }

        if ($value instanceof \Throwable) {
            return self::exception($value);
        }

        if ($value instanceof \DateTimeInterface) {
            return $value->format(\DateTimeInterface::RFC3339_EXTENDED);
        }

        if ($value instanceof \JsonSerializable) {
            return self::value($value->jsonSerialize(), $depth + 1);
        }

        if ($value instanceof \UnitEnum) {
            return $value instanceof \BackedEnum ? $value->value : $value->name;
        }

        if ($value instanceof \Stringable) {
            return self::truncate((string) $value);
        }

        if (is_object($value)) {
            return '[object ' . $value::class . ']';
        }

        return '[' . get_debug_type($value) . ']';
    }

    private static function truncate(string $text, int $max = self::MAX_STRING_CHARS): string
    {
        return strlen($text) > $max ? substr($text, 0, $max) . '…' : $text;
    }
}
