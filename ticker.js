// Worker timers aren't throttled the way hidden-page timers are.
setInterval(() => postMessage(0), 1000);
