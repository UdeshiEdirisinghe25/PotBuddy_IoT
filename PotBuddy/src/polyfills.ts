const g = globalThis as any;

if (!g.location) {
  g.location = { hostname: "localhost", host: "localhost", href: "", protocol: "https:" };
}
if (g.window && !g.window.location) {
  g.window.location = g.location;
}

export {};