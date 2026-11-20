/** Whether this browser reaches the hub at an address local to this machine. */
export function isLoopback(hostname: string) {
  return /(?:^|\.)localhost\.?$|^\[::1\]$|^127\.\d+\.\d+\.\d+$/.test(hostname);
}
