import { type FormEvent, useState, useTransition } from "react";

import { describeFailure } from "../lib/failures";

export function useSubmit(submit: (fields: FormData, form: HTMLFormElement) => Promise<unknown>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    startTransition(async () => {
      setError(null);
      try {
        await submit(new FormData(form), form);
      } catch (cause) {
        const message = describeFailure(cause);
        startTransition(() => setError(message));
      }
    });
  };
  return { error, pending, onSubmit };
}
