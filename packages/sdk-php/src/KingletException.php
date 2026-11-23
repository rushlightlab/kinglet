<?php

declare(strict_types=1);

namespace Kinglet;

/**
 * A batch Kinglet did not accept. Passed to the client's `onError`; logging
 * calls themselves never throw.
 */
final class KingletException extends \RuntimeException
{
    public function __construct(
        string $message,
        /** HTTP status, or null for a network error. */
        public readonly ?int $status = null,
        /** Events in the batch this error is about. */
        public readonly int $events = 0,
    ) {
        parent::__construct($message, $status ?? 0);
    }
}
