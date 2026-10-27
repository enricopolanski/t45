import { Fragment, type ReactNode } from "react";

import { useRowKeys } from "../../hooks/useRowKeys";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function RowsEditor<Row>({
  rows,
  onChange,
  blank,
  addLabel,
  actions,
  children,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly onChange: (rows: ReadonlyArray<Row>) => void;
  readonly blank: Row;
  readonly addLabel: string;
  readonly actions?: ReactNode;
  readonly children: (
    row: Row,
    edit: (change: Partial<Row>) => void,
    remove: ReactNode,
  ) => ReactNode;
}) {
  const keys = useRowKeys(rows.length);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <Fragment key={keys.keys[index]}>
          {children(
            row,
            (change) =>
              onChange(
                rows.map((current, at) => (at === index ? { ...current, ...change } : current)),
              ),
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                keys.remove(index);
                onChange(rows.filter((_, at) => at !== index));
              }}
            >
              Remove
            </Button>,
          )}
        </Fragment>
      ))}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...rows, blank])}
        >
          {addLabel}
        </Button>
        {actions}
      </div>
    </div>
  );
}

interface FileRow {
  readonly path: string;
  readonly content: string;
}

export const fileRows = (files: Readonly<Record<string, string>>): ReadonlyArray<FileRow> =>
  Object.entries(files).map(([path, content]) => ({ path, content }));

export const fileRecord = (rows: ReadonlyArray<FileRow>) =>
  Object.fromEntries(rows.map((file) => [file.path, file.content]));

/** Text files at relative paths, such as an agent's or a skill's scripts. */
export function FilesEditor({
  files,
  onChange,
}: {
  readonly files: ReadonlyArray<FileRow>;
  readonly onChange: (files: ReadonlyArray<FileRow>) => void;
}) {
  return (
    <RowsEditor
      rows={files}
      onChange={onChange}
      blank={{ path: "", content: "" }}
      addLabel="Add file"
    >
      {(file, edit, remove) => (
        <div className="flex flex-col gap-1 rounded-md border border-border p-2">
          <div className="flex gap-2">
            <Input
              aria-label="File path"
              placeholder="Path, such as scripts/extract.py"
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}(/[A-Za-z0-9][A-Za-z0-9._\-]{0,63})*"
              value={file.path}
              onChange={(event) => edit({ path: event.target.value })}
            />
            {remove}
          </div>
          <Textarea
            aria-label={`Contents of ${file.path || "new file"}`}
            rows={6}
            value={file.content}
            onChange={(event) => edit({ content: event.target.value })}
          />
        </div>
      )}
    </RowsEditor>
  );
}
