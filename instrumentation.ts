// Start sampling when the server boots so chart history accumulates even with no browser open.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startSampler } = await import("./lib/sampler");
    startSampler();
  }
}
