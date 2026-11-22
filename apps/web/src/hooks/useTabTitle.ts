import { useEffect } from "react";

export function useTabTitle(title: string) {
  const name = title.trim();
  useEffect(() => {
    document.title = name === "" ? "T45" : `${name} · T45`;
    return () => {
      document.title = "T45";
    };
  }, [name]);
}
