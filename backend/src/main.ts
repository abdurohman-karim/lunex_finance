import './instrument.js';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
configureApp(app);

const config = app.get<ConfigService<Env, true>>(ConfigService);
// Behind a proxy every request comes from it: rate limits need the client's address.
const proxies = config.get('TRUST_PROXY', { infer: true });
if (proxies > 0) app.set('trust proxy', proxies);
const port = config.get('PORT', { infer: true });
const host = config.get('HOST', { infer: true });
await (host ? app.listen(port, host) : app.listen(port));
