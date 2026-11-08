const PERIOD = 4 * 60 * 60 * 1000;

export function createUpdateCoordinator({ legacy, application, publish = () => {}, setTimer = setInterval, clearTimer = clearInterval, period = PERIOD }) {
  const services = { legacy, application };
  const subscriptions = new Set();
  let state = { status: "idle" };
  let stopped = false;
  let started = false;
  let timer;
  let checking;
  let sourceChecking;
  let ready;
  let verified;

  const change = (next) => {
    if (stopped) return;
    state = { ...next };
    publish({ ...state });
  };
  const revoke = () => { ready = undefined; verified = undefined; };

  function receive(source, next) {
    if (stopped || !services[source] || (ready && ready.source !== source)) return;
    if (next.status === "downloaded") {
      if (sourceChecking && sourceChecking !== source) return;
      ready ??= { source, service: services[source] };
      change(next);
      return;
    }
    if (sourceChecking !== source) return;
    if (ready) revoke();
    change(next);
  }

  function failed(candidate) {
    if (stopped || ready !== candidate) return;
    revoke();
    const snapshot = candidate.service.getState();
    // 某些安装器失败后仍保留 downloaded；撤销本层选择，允许下一次检查重试。
    change(snapshot.status === "downloaded"
      ? { status: "error", ...(snapshot.version ? { version: snapshot.version } : {}) }
      : snapshot);
  }

  async function runCheck() {
    if (stopped || ready) return;
    for (const source of ["legacy", "application"]) {
      const service = services[source];
      if (!service) continue;
      sourceChecking = source;
      try {
        await service.check();
      } catch {
        if (stopped) return;
        const snapshot = service.getState();
        if (ready?.source === source) revoke();
        change(snapshot.status === "error" ? snapshot : { status: "error" });
        continue;
      }
      if (stopped) return;
      receive(source, service.getState());
      // 完整壳更新优先；应用层预览也不能抢占已下载的壳更新。
      if (ready) return;
    }
  }

  function check() {
    if (stopped || ready) return Promise.resolve();
    if (!checking) {
      checking = Promise.resolve().then(runCheck).finally(() => {
        sourceChecking = undefined;
        checking = undefined;
      });
    }
    return checking;
  }

  const canInstall = () => !stopped && !!ready && ready.service.canInstall();
  return {
    receive,
    getState: () => ({ ...state }),
    check,
    canInstall,
    async verifyForInstall() {
      verified = undefined;
      if (stopped || !ready) throw new Error("Update is not ready for installation");
      const candidate = ready;
      try {
        if (!canInstall()) throw new Error("Update is download-only");
        await candidate.service.verifyForInstall();
        if (stopped || ready !== candidate) throw new Error("Update selection changed during verification");
        verified = candidate;
      } catch (error) {
        failed(candidate);
        throw error;
      }
    },
    onInstallError(listener) {
      if (stopped || !ready) return () => {};
      const candidate = ready;
      let subscribed = true;
      const remove = candidate.service.onInstallError((error) => {
        if (stopped || !subscribed) return;
        failed(candidate);
        listener(error);
      });
      const unsubscribe = () => {
        if (!subscribed) return;
        subscribed = false;
        subscriptions.delete(unsubscribe);
        remove();
      };
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
    async quitAndInstall() {
      if (!canInstall() || verified !== ready) throw new Error("Update is not verified for installation");
      const candidate = ready;
      verified = undefined;
      try { await candidate.service.quitAndInstall(); }
      catch (error) { failed(candidate); throw error; }
    },
    start() {
      if (stopped || started) return;
      started = true;
      timer = setTimer(() => void check(), period);
      timer?.unref?.();
      void check();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      revoke();
      if (started) clearTimer(timer);
      for (const unsubscribe of subscriptions) unsubscribe();
      legacy?.stop();
      application?.stop();
    },
  };
}
