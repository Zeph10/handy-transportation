// Type-check shim so `tsc -p supabase/functions` works without Deno installed.
// The real runtime is Supabase Edge Functions (Deno), which provides these.
declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}
