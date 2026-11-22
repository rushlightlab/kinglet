<?php

declare(strict_types=1);

namespace Kinglet\Tests;

use Kinglet\Client;
use Kinglet\Monolog\KingletHandler;
use Kinglet\Psr\KingletLogger;
use Monolog\Level;
use Monolog\Logger;
use Monolog\Processor\ProcessIdProcessor;
use PHPUnit\Framework\TestCase;

final class IntegrationsTest extends TestCase
{
    private FakeTransport $transport;

    protected function setUp(): void
    {
        $this->transport = new FakeTransport();
    }

    private function client(): Client
    {
        return new Client(
            url: 'https://logs.example.com',
            token: 'kl_test',
            service: 'web',
            flushInterval: 3600.0,
            flushOnShutdown: false,
            transport: $this->transport,
        );
    }

    public function testPsr3LoggerInterpolatesAndKeepsTheContextAsFields(): void
    {
        $logger = new KingletLogger($this->client());

        $logger->warning('Payment {id} retried {attempts} times', ['id' => 'pay_42', 'attempts' => 2]);
        $logger->notice('notice maps to info');
        $logger->client()->flush();

        [$warning, $notice] = $this->transport->events();

        self::assertSame('warn', $warning['level']);
        self::assertSame('Payment pay_42 retried 2 times', $warning['message']);
        self::assertSame(['id' => 'pay_42', 'attempts' => 2], $warning['fields']);
        self::assertSame('info', $notice['level']);
    }

    public function testPsr3LoggerLeavesUnknownPlaceholdersAlone(): void
    {
        $logger = new KingletLogger($this->client());

        $logger->info('Hello {name}');
        $logger->client()->flush();

        self::assertSame(['Hello {name}'], $this->transport->messages());
    }

    public function testPsr3LoggerDescribesAnExceptionInTheContext(): void
    {
        $logger = new KingletLogger($this->client());

        $logger->error('Checkout failed', ['exception' => new \DomainException('card declined')]);
        $logger->client()->flush();

        [$event] = $this->transport->events();

        self::assertSame('error', $event['level']);
        self::assertSame(\DomainException::class, $event['fields']['exception']['class']);
        self::assertSame('card declined', $event['fields']['exception']['message']);
    }

    public function testMonologHandlerSendsRecordsWithChannelAndExtra(): void
    {
        $handler = new KingletHandler($this->client());
        $logger = new Logger('billing', [$handler], [new ProcessIdProcessor()]);

        $logger->critical('Invoice job crashed', ['invoice' => 'inv_7']);
        $handler->close();

        [$event] = $this->transport->events();

        self::assertSame('fatal', $event['level']);
        self::assertSame('Invoice job crashed', $event['message']);
        self::assertSame('inv_7', $event['fields']['invoice']);
        self::assertSame('billing', $event['fields']['channel']);
        self::assertSame(getmypid(), $event['fields']['extra']['process_id']);
    }

    public function testMonologHandlerRespectsItsMinimumLevel(): void
    {
        $handler = new KingletHandler($this->client(), level: Level::Warning);
        $logger = new Logger('app', [$handler]);

        $logger->info('too quiet');
        $logger->error('loud enough');
        $handler->close();

        self::assertSame(['loud enough'], $this->transport->messages());
    }

    public function testMonologHandlerCanBeConfiguredWithPlainSettings(): void
    {
        $handler = new KingletHandler(url: 'https://logs.example.com', token: 'kl_config', service: 'queue');

        self::assertTrue($handler->client()->enabled());
    }
}
