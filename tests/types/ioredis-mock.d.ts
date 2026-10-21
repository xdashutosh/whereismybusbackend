// Minimal typing for the ioredis-mock test double (it mirrors the ioredis API).
declare module 'ioredis-mock' {
  import type { Redis, RedisOptions } from 'ioredis';
  const RedisMock: new (options?: RedisOptions) => Redis;
  export default RedisMock;
}
