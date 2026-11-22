<?php

declare(strict_types=1);

namespace Kinglet;

/**
 * Kinglet's severity scale, least to most severe.
 */
enum Level: string
{
    case Trace = 'trace';
    case Debug = 'debug';
    case Info = 'info';
    case Warn = 'warn';
    case Error = 'error';
    case Fatal = 'fatal';

    /**
     * Maps a level name from Kinglet, PSR-3, or Monolog onto Kinglet's scale.
     * PSR-3 `notice` becomes info; `critical`, `alert`, and `emergency` become
     * fatal. Unknown names are info, like the server.
     */
    public static function fromName(string $name): self
    {
        return match (strtolower(trim($name))) {
            'trace' => self::Trace,
            'debug' => self::Debug,
            'warn', 'warning' => self::Warn,
            'error', 'err' => self::Error,
            'fatal', 'critical', 'alert', 'emergency' => self::Fatal,
            default => self::Info,
        };
    }
}
