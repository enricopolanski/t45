import type { ReactNode } from "react";

export function StandalonePage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background bg-linear-145 from-black/8 to-transparent to-55% px-4 py-10 text-foreground sm:px-6">
      <section className="w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        {children}
      </section>
    </div>
  );
}

export function StandalonePageHeader({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <>
      <p className="text-2xs font-semibold tracking-widest text-muted-foreground uppercase">T45</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}
