export const ControlMsgType = Object.freeze({
  HELLO: "hello",
  CONTROL: "control",
  RELEASE: "release",
  PING: "ping",
  PONG: "pong",
  KILL: "kill",
});

export function makeHello({ name }) {
  return { t: ControlMsgType.HELLO, name };
}

export function makeControl({ tick, moveX, moveY, kick }) {
  return {
    t: ControlMsgType.CONTROL,
    tick,
    moveX,
    moveY,
    kick: Boolean(kick),
    kickPower: 1.0,
  };
}

export function makeRelease(reason = "release") {
  return { t: ControlMsgType.RELEASE, reason };
}

