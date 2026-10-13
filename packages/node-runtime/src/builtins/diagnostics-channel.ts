type ChannelSubscriber = (message: unknown, name: string) => void;

export class Channel {
  readonly name: string;
  #subscribers = new Set<ChannelSubscriber>();

  constructor(name: string) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return this.#subscribers.size > 0;
  }

  publish(message: unknown): void {
    for (const subscriber of this.#subscribers) subscriber(message, this.name);
  }

  subscribe(subscriber: ChannelSubscriber): void {
    this.#subscribers.add(subscriber);
  }

  unsubscribe(subscriber: ChannelSubscriber): boolean {
    return this.#subscribers.delete(subscriber);
  }
}

const channels = new Map<string, Channel>();

export function channel(name: string | symbol): Channel {
  const key = String(name);
  let value = channels.get(key);
  if (!value) {
    value = new Channel(key);
    channels.set(key, value);
  }
  return value;
}

export function hasSubscribers(name: string | symbol): boolean {
  return channel(name).hasSubscribers;
}

export const diagnosticsChannelBuiltin = Object.freeze({ Channel, channel, hasSubscribers });
