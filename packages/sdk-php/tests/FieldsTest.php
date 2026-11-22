<?php

declare(strict_types=1);

namespace Kinglet\Tests;

use Kinglet\Fields;
use Kinglet\Level;
use PHPUnit\Framework\TestCase;

final class FieldsTest extends TestCase
{
    public function testKeepsJsonValuesAsTheyAre(): void
    {
        self::assertSame(
            ['s' => 'x', 'i' => 3, 'f' => 1.5, 'b' => true, 'n' => null, 'list' => [1, 2], 'map' => ['k' => 'v']],
            Fields::normalize(['s' => 'x', 'i' => 3, 'f' => 1.5, 'b' => true, 'n' => null, 'list' => [1, 2], 'map' => ['k' => 'v']]),
        );
    }

    public function testDescribesAnExceptionWithItsCause(): void
    {
        $error = new \RuntimeException('outer', 7, new \InvalidArgumentException('inner'));

        $fields = Fields::normalize(['exception' => $error]);
        $exception = $fields['exception'];

        self::assertIsArray($exception);
        self::assertSame(\RuntimeException::class, $exception['class']);
        self::assertSame('outer', $exception['message']);
        self::assertSame(7, $exception['code']);
        self::assertSame(__FILE__, $exception['file']);
        self::assertIsString($exception['trace']);
        self::assertSame('inner', $exception['previous']['message']);
    }

    public function testWritesDatesAsIso8601(): void
    {
        $fields = Fields::normalize(['at' => new \DateTimeImmutable('2026-01-02T03:04:05.678+00:00')]);

        self::assertSame('2026-01-02T03:04:05.678+00:00', $fields['at']);
    }

    public function testUsesJsonSerializableStringableAndEnums(): void
    {
        $json = new class () implements \JsonSerializable {
            public function jsonSerialize(): mixed
            {
                return ['shape' => 'json'];
            }
        };

        $text = new class () implements \Stringable {
            public function __toString(): string
            {
                return 'as text';
            }
        };

        $fields = Fields::normalize(['json' => $json, 'text' => $text, 'level' => Level::Warn]);

        self::assertSame(['shape' => 'json'], $fields['json']);
        self::assertSame('as text', $fields['text']);
        self::assertSame('warn', $fields['level']);
    }

    public function testNamesOtherObjectsInsteadOfDumpingThem(): void
    {
        self::assertSame('[object stdClass]', Fields::normalize(['o' => new \stdClass()])['o']);
    }

    public function testReplacesNonFiniteNumbersThatJsonCannotHold(): void
    {
        $fields = Fields::normalize(['nan' => NAN, 'inf' => INF, 'ninf' => -INF]);

        self::assertSame('NaN', $fields['nan']);
        self::assertSame('Infinity', $fields['inf']);
        self::assertSame('-Infinity', $fields['ninf']);
    }

    public function testKeepsSixLevelsOfNestingAndCutsTheRest(): void
    {
        $deep = ['a' => ['b' => ['c' => ['d' => ['e' => ['f' => ['g' => ['h' => 'too deep']]]]]]]];

        $fields = Fields::normalize($deep);

        self::assertSame('[depth limit]', $fields['a']['b']['c']['d']['e']['f']['g']);
    }
}
