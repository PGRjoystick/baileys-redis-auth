import Redis, { RedisOptions, Redis as RedisClient } from 'ioredis';
import {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';

interface IDeleteHSetKeyOptions {
  redis: RedisClient;
  key: string;
}

interface IDeleteKeysOptions {
  redis: RedisClient;
  pattern: string;
}

const createKey = (key: string, prefix: string) => `${key}:${prefix}`;

export const useRedisAuthStateWithHSet = async (
  redisOptions: RedisOptions,
  prefix: string = 'DB1'
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; redis: RedisClient }> => {
  const redis = new Redis(redisOptions);
  redis.on('connect', async () => {
    const redisClientName = `baileys-auth-${prefix}`;
    await redis.client('SETNAME', redisClientName);
    console.log(`Redis client name set to ${redisClientName}`);
  });

  const writeData = (key: string, field: string, data: any) =>
    redis.hset(createKey(key, prefix), field, JSON.stringify(data, BufferJSON.replacer));

  const readData = async (key: string, field: string) => {
    const data = await redis.hget(createKey(key, prefix), field);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
  };

  const creds: AuthenticationCreds = (await readData('authState', 'creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const hashKey = createKey('authState', prefix);
          const fieldsArray = ids.map((id) => `${type}-${id}`);
          // ioredis hmget expects separate fields, spread the array
          const rawValues = await redis.hmget(hashKey, ...fieldsArray);
          const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};

          ids.forEach((id, index) => {
            const rawValue = rawValues[index];
            if (rawValue) {
              const value = JSON.parse(rawValue, BufferJSON.reviver);
              // In Baileys v7 the helper `fromObject` may not exist; return raw value instead.
              data[id] = value as SignalDataTypeMap[typeof type];
            }
          });
          return data;
        },
        set: async (data) => {
          const pipeline = redis.pipeline();
          for (const category in data) {
            for (const id in data[category]) {
              const field = `${category}-${id}`;
              const value = data[category][id];
              if (value) {
                pipeline.hset(
                  createKey('authState', prefix),
                  field,
                  JSON.stringify(value, BufferJSON.replacer)
                );
              } else {
                pipeline.hdel(createKey('authState', prefix), field);
              }
            }
          }
          await pipeline.exec();
        },
      },
    },
    saveCreds: async () => {
      await writeData('authState', 'creds', creds);
    },
    redis,
  };
};

export const deleteHSetKeys = async ({ redis, key }: IDeleteHSetKeyOptions): Promise<void> => {
  try {
    console.log('removing authState keys', key);
    await redis.del(createKey('authState', key));
  } catch (err) {
    console.log('Error deleting keys:', err.message);
  }
};

export const useRedisAuthState = async (
  redisOptions: RedisOptions,
  prefix: string = 'DB1'
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; redis: RedisClient }> => {
  const redis = new Redis(redisOptions);

  const writeData = async (data: any, key: string): Promise<void> => {
    await redis.set(`${prefix}:${key}`, JSON.stringify(data, BufferJSON.replacer));
  };

  const readData = async (key: string): Promise<any> => {
    const data = await redis.get(`${prefix}:${key}`);
    return data ? JSON.parse(data, BufferJSON.reviver) : null;
  };

  const creds: AuthenticationCreds = (await readData('creds')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const keysArray = ids.map((id) => `${prefix}:${type}-${id}`);
          const rawValues = await redis.mget(keysArray);

          return ids.reduce(
            (acc, id, index) => {
              const rawValue = rawValues[index];
              if (rawValue) {
                const value = JSON.parse(rawValue, BufferJSON.reviver);
                acc[id] = value as SignalDataTypeMap[typeof type];
              }
              return acc;
            },
            {} as { [_: string]: SignalDataTypeMap[typeof type] }
          );
        },
        set: async (data) => {
          const pipeline = redis.pipeline();
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${prefix}:${category}-${id}`;
              value
                ? pipeline.set(key, JSON.stringify(value, BufferJSON.replacer))
                : pipeline.del(key);
            }
          }
          await pipeline.exec();
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    },
    redis,
  };
};

export const deleteKeysWithPattern = async ({
  redis,
  pattern,
}: IDeleteKeysOptions): Promise<void> => {
  let cursor = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = parseInt(nextCursor, 10);
    if (keys.length > 0) {
      await redis.unlink(...keys);
      console.log(`Deleted keys: ${keys}`);
    }
  } while (cursor !== 0);
};
