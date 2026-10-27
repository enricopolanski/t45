import { useState } from "react";

import { randomUUID } from "~/lib/utils";

function fitKeys(keys: ReadonlyArray<string>, count: number): ReadonlyArray<string> {
  if (keys.length === count) return keys;
  if (keys.length > count) return keys.slice(0, count);
  return [...keys, ...Array.from({ length: count - keys.length }, randomUUID)];
}

/**
 * Stable React keys for the rows of an editable list whose items have no id,
 * so removing a row keeps the inputs below it (and their focus) in place.
 *
 * Call `remove(index)` along with removing that row. Rows appended at the end
 * get new keys on their own, and a list replaced wholesale is resized to fit.
 *
 *   const rows = useRowKeys(files.length);
 *   files.map((file, index) => <FileRow key={rows.keys[index]} ... />)
 */
export function useRowKeys(count: number) {
  const [keys, setKeys] = useState<ReadonlyArray<string>>(() =>
    Array.from({ length: count }, randomUUID),
  );
  const fitted = fitKeys(keys, count);
  if (fitted !== keys) setKeys(fitted);
  return {
    keys: fitted,
    remove: (index: number) => setKeys((current) => current.filter((_, at) => at !== index)),
  };
}
