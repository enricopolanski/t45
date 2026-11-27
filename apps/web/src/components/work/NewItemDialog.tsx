import { getLocale, useTranslation } from "~/i18n/locale";
import { type Field, type FieldValues, rowIds } from "@t45/contracts/models/Field";
import type { Project } from "@t45/contracts/models/Workflow";
import type { FieldValue, FieldView } from "@t45/contracts/resources/Workflows";
import { buildFieldViews } from "@t45/core/fieldViews";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  FileTextIcon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { useSubmit } from "../../hooks/useSubmit";
import { formatAttachmentSize } from "../../lib/attachmentFiles";
import { describeFailure } from "../../lib/failures";
import { cn } from "../../lib/utils";
import { api } from "../../rpc/api";
import { refreshStartableProjects, useStartableProjects, workChanged } from "../../state/work";
import { makeFileDropHandlers } from "../chat/fileDrop";
import { Loading } from "../Loading";
import { MarkdownText } from "../markdown/MarkdownText";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Field as FormField } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { newKey } from "../workflows/workflowLogic";
import { FieldInputs, type FileEntry, uploadFile } from "./StepFields";
import { missingFields, stepNameParts } from "./workLogic";

const NO_PROJECT = "There's no project you can start items in yet.";
const NO_KEYS: ReadonlySet<string> = new Set();

type StartableProject = ReturnType<typeof useStartableProjects>[number];

/** The file field of a group that holds files only, an entry each; null for any other field. */
const filesFieldOf = (field: Field) => {
  const [only] = field.type === "group" && field.repeatable ? field.fields : [];
  return field.type === "group" && field.fields.length === 1 && only?.type === "file" ? only : null;
};

/** `values` with the field at `key` set to `value`; a group's rows it no longer lists go. */
const withValue = (values: FieldValues, key: string, value: FieldValue): FieldValues => {
  const rows = Array.isArray(value) ? value : [];
  const others = Object.fromEntries(
    Object.entries(values).filter(
      ([other]) =>
        other !== key &&
        (!other.startsWith(`${key}.`) ||
          rows.includes(other.slice(key.length + 1).split(".")[0] ?? "")),
    ),
  );
  const isBlank =
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0);
  return isBlank ? others : { ...others, [key]: value };
};

/**
 * The values of the first step's provided inputs, kept here until the item starts. A file uploads
 * as it's picked, and its value, or its entry in a group of files, appears once it's uploaded.
 */
function useInputDraft() {
  const [values, setValues] = useState<FieldValues>({});
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(new Map());
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [uploading, setUploading] = useState<
    ReadonlyArray<{ readonly id: string; readonly target: string; readonly name: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  // Read when the form submits, which can follow an edit before it renders.
  const latest = useRef(values);
  // Counts clears, so an upload that ends after one changes nothing.
  const generation = useRef(0);
  const change = (next: (held: FieldValues) => FieldValues) => {
    latest.current = next(latest.current);
    setValues(latest.current);
  };
  const upload = (
    target: string,
    file: File,
    place: (held: FieldValues, id: string) => FieldValues,
  ) => {
    const started = generation.current;
    const pending = { id: newKey("row"), target, name: file.name };
    setUploading((held) => [...held, pending]);
    setError(null);
    void uploadFile(file)
      .then(
        (id) => {
          if (generation.current !== started) return;
          setSizes((held) => new Map(held).set(id, file.size));
          setNames((held) => new Map(held).set(id, file.name));
          change((held) => place(held, id));
        },
        (cause: unknown) => {
          if (generation.current === started) setError(describeFailure(cause));
        },
      )
      .finally(() => setUploading((held) => held.filter((entry) => entry !== pending)));
  };
  const addFileEntries = (
    groupKey: string,
    _rows: ReadonlyArray<string>,
    added: ReadonlyArray<FileEntry>,
  ) => {
    for (const { rowId, fieldKey, file } of added)
      upload(groupKey, file, (held, id) => ({
        ...withValue(held, groupKey, [...rowIds(held[groupKey]), rowId]),
        [fieldKey]: id,
      }));
  };
  return {
    values,
    error,
    uploading,
    latest: () => latest.current,
    fileOf: (id: string) => {
      const name = names.get(id);
      return name === undefined ? null : { id, name };
    },
    sizeOf: (id: string) => sizes.get(id),
    save: (fieldKey: string, value: FieldValue) =>
      change((held) => withValue(held, fieldKey, value)),
    upload: (fieldKey: string, file: File) =>
      upload(fieldKey, file, (held, id) => ({ ...held, [fieldKey]: id })),
    addFileEntries,
    addFiles: (groupKey: string, fileFieldId: string, files: ReadonlyArray<File>) =>
      addFileEntries(
        groupKey,
        [],
        files.map((file) => {
          const rowId = newKey("row");
          return { rowId, fieldKey: `${groupKey}.${rowId}.${fileFieldId}`, file };
        }),
      ),
    clear: () => {
      generation.current += 1;
      change(() => ({}));
      setUploading([]);
      setError(null);
    },
  };
}

type InputDraft = ReturnType<typeof useInputDraft>;

/**
 * Starts an item in a project the viewer picks from those they may start, or in the given one:
 * its title and what the first step asks for, beside the steps it will go through.
 */
export function NewItemDialog({ project }: { readonly project?: Pick<Project, "id" | "name"> }) {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (isOpen) refreshStartableProjects();
        setOpen(isOpen);
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <PlusIcon />
        {t("New item")}
      </DialogTrigger>
      <DialogPopup className="sm:max-w-5xl" aria-label={t("New item")}>
        <Loading>
          <StartForm projectId={project?.id ?? null} onDone={() => setOpen(false)} />
        </Loading>
      </DialogPopup>
    </Dialog>
  );
}

function StartForm({
  projectId,
  onDone,
}: {
  readonly projectId: string | null;
  readonly onDone: () => void;
}) {
  const t = useTranslation();
  const navigate = useNavigate();
  const projects = useStartableProjects();
  const [chosenId, setChosenId] = useState(projectId);
  const [title, setTitle] = useState("");
  // Set once Start is tried; from then on, what's missing shows and clears as it's filled.
  const [triedStart, setTriedStart] = useState(false);
  const titleId = useId();
  const draft = useInputDraft();
  const chosen = projects.find(({ id }) => id === (chosenId ?? projects[0]?.id));
  const { error, pending, onSubmit } = useSubmit(async () => {
    if (chosen === undefined) return;
    const values = draft.latest();
    const result = await api("workflows.startTicket", {
      projectId: chosen.id,
      title,
      ...(Object.keys(values).length > 0 ? { values } : {}),
    });
    workChanged();
    onDone();
    void navigate({ to: "/my-work/$stepId", params: result });
  });
  if (chosen === undefined)
    return (
      <DialogHeader>
        <DialogTitle>{t("New item")}</DialogTitle>
        <p className="text-base text-muted-foreground">{NO_PROJECT}</p>
      </DialogHeader>
    );
  const inputs = chosen.providedInputs.flatMap(({ field, isRequired }) =>
    buildFieldViews(
      [isRequired ? field : { ...field, label: t("{0} (optional)", field.label) }],
      draft.values,
      draft.fileOf,
    ).map((view) => ({ field, isRequired, view, isFilled: missingFields([view]).length === 0 })),
  );
  const isTitled = title.trim() !== "";
  const missing = [
    ...(isTitled ? [] : [t("a title")]),
    ...inputs.flatMap(({ field, isRequired, isFilled, view }) =>
      !isRequired || isFilled
        ? []
        : [filesFieldOf(field) === null ? view.label : t("at least one file")],
    ),
  ];
  const fileCount = inputs
    .filter(({ field }) => filesFieldOf(field) !== null)
    .reduce((count, { view }) => count + view.rows.length, 0);
  const isMissing = triedStart && missing.length > 0;
  const problem = error ?? draft.error;
  const status =
    problem ??
    (missing.length > 0
      ? isMissing
        ? t(
            "Add {0} to start.",
            new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(missing),
          )
        : null
      : fileCount === 0
        ? null
        : fileCount === 1
          ? t("Step 1 will read 1 file.")
          : t("Step 1 will read {0} files.", fileCount));
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        setTriedStart(true);
        if (missing.length === 0) onSubmit(event);
        else event.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle size="lg">{chosen.workflowName}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="flex min-w-0 flex-col gap-4">
            {projectId === null && projects.length > 1 ? (
              <ProjectChoice
                projects={projects}
                chosenId={chosen.id}
                onChoose={(next) => {
                  setChosenId(next);
                  draft.clear();
                }}
              />
            ) : null}
            <div className="flex flex-col gap-4">
              <Section
                isDone={isTitled}
                isMissing={triedStart && !isTitled}
                heading={<label htmlFor={titleId}>{t("Title")}</label>}
              >
                <Input
                  id={titleId}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={chosen.titlePlaceholder || t("e.g. Customer onboarding")}
                  size="lg"
                />
              </Section>
              {inputs.map(({ field, view, isFilled, isRequired }) => {
                const filesField = filesFieldOf(field);
                return (
                  <Section
                    key={view.key}
                    isDone={isFilled}
                    isMissing={triedStart && isRequired && !isFilled}
                    heading={filesField === null ? undefined : view.label}
                  >
                    {filesField === null ? (
                      <FieldInputs
                        fields={[view]}
                        missing={NO_KEYS}
                        onSave={draft.save}
                        onUpload={draft.upload}
                        onAddFileEntries={draft.addFileEntries}
                      />
                    ) : (
                      <FilesInput view={view} fileFieldId={filesField.id} draft={draft} />
                    )}
                  </Section>
                );
              })}
            </div>
          </div>
          <StepList project={chosen} />
        </div>
      </DialogPanel>
      <DialogFooter>
        <p
          className={cn(
            "self-center text-base sm:me-auto",
            problem !== null || isMissing ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {status}
        </p>
        <DialogClose render={<Button type="button" variant="outline" size="lg" />}>
          {t("Cancel")}
        </DialogClose>
        <Button type="submit" size="lg" disabled={draft.uploading.length > 0 || pending}>
          {t("Start Step 1")}
          <ArrowRightIcon />
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A part of the form, numbered, ticked once it's filled in. */
function Section({
  isDone,
  isMissing,
  heading,
  children,
}: {
  readonly isDone: boolean;
  /** Start was pressed while it's empty. */
  readonly isMissing: boolean;
  readonly heading?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full",
            isDone
              ? "bg-success text-white"
              : isMissing
                ? "bg-destructive text-white"
                : "bg-border-strong",
          )}
        >
          {isDone ? (
            <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden />
          ) : isMissing ? (
            <svg
              viewBox="0 0 24 24"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M12 6v8M12 18h.01" />
            </svg>
          ) : null}
        </span>
        {heading === undefined ? null : <h3 className="text-lg font-semibold">{heading}</h3>}
      </div>
      {children}
    </section>
  );
}

/** A group of files: what they should hold, the ones added, and where to drop more. */
function FilesInput({
  view,
  fileFieldId,
  draft,
}: {
  readonly view: FieldView;
  readonly fileFieldId: string;
  readonly draft: InputDraft;
}) {
  const t = useTranslation();
  const [isDragActive, setIsDragActive] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const added = view.rows.flatMap(({ id, fields }) => {
    const file = fields[0]?.file;
    return id === null || !file ? [] : [{ rowId: id, file }];
  });
  const uploading = draft.uploading.filter(({ target }) => target === view.key);
  const addFiles = (files: ReadonlyArray<File>) => draft.addFiles(view.key, fileFieldId, files);
  const describe = ({ id, name }: { readonly id: string; readonly name: string }) => {
    const extension = name.includes(".") ? name.split(".").at(-1)?.toUpperCase() : undefined;
    const size = draft.sizeOf(id);
    return [extension, size === undefined ? undefined : formatAttachmentSize(size)]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <div className="flex flex-col gap-3">
      {view.description ? (
        <MarkdownText text={view.description} className="text-base text-muted-foreground" />
      ) : null}
      {added.length + uploading.length > 0 ? (
        <ul aria-label={t("Uploaded files")} className="flex flex-col divide-y rounded-lg border">
          {added.map(({ rowId, file }) => (
            <li key={rowId} className="flex items-center gap-3 px-3 py-2">
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-base font-medium">{file.name}</span>
                <span className="text-sm text-muted-foreground">{describe(file)}</span>
              </div>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("Remove {0}", file.name)}
                onClick={() =>
                  draft.save(
                    view.key,
                    added.flatMap((other) => (other.rowId === rowId ? [] : [other.rowId])),
                  )
                }
              >
                <XIcon />
              </Button>
            </li>
          ))}
          {uploading.map(({ id, name }) => (
            <li key={id} className="flex items-center gap-3 px-3 py-2">
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-base">{name}</span>
              <span className="text-sm text-muted-foreground">{t("Uploading…")}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={cn(
          "flex flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center",
          isDragActive ? "border-primary bg-primary/4" : "border-border",
        )}
        {...makeFileDropHandlers({ setDragActive: setIsDragActive, addFiles })}
      >
        <UploadIcon className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-base font-medium">
          {added.length > 0 ? t("Add more files, or") : t("Drop files here, or")}{" "}
          <button
            type="button"
            className="cursor-pointer text-primary underline underline-offset-2"
            onClick={() => picker.current?.click()}
          >
            {t("browse")}
          </button>
        </p>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) addFiles(files);
          }}
        />
      </div>
    </div>
  );
}

/** The workflow's steps the viewer works on, each with what it does. */
function StepList({ project }: { readonly project: StartableProject }) {
  const t = useTranslation();
  // This dialog is step 0: what the workflow's steps will work from.
  const items = [
    {
      number: 0,
      name: t("Item creation"),
      summary: t("Gathering the data required to start the process"),
    },
    ...project.steps.map((step) => ({
      number: step.number,
      name: stepNameParts.exec(step.name)?.[2] ?? step.name,
      summary: [
        step.number === 1 && project.startsOnEntry ? t("Starts right away.") : "",
        step.summary,
      ]
        .filter(Boolean)
        .join(" "),
    })),
  ];
  return (
    <ol
      aria-label={t("Item steps")}
      className="flex flex-col rounded-xl bg-muted/60 p-4 md:self-start"
    >
      {items.map(({ number, name, summary }, index) => {
        const isLast = index === items.length - 1;
        return (
          <li key={number} className="flex gap-3" aria-current={number === 0 ? "step" : undefined}>
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  number === 0
                    ? "bg-primary text-primary-foreground"
                    : "border-2 border-border text-muted-foreground",
                )}
              >
                {number}
              </span>
              {isLast ? null : number === 0 ? (
                // An arrow from this dialog into the step that starts next.
                <>
                  <span aria-hidden className="min-h-4 w-0.5 flex-1 bg-primary" />
                  <ChevronDownIcon
                    aria-hidden
                    strokeWidth={3}
                    className="-mt-3 size-5 shrink-0 text-primary"
                  />
                </>
              ) : (
                <span aria-hidden className="min-h-4 w-0.5 flex-1 bg-border" />
              )}
            </div>
            <div className={cn("flex min-w-0 flex-col gap-1", !isLast && "pb-4")}>
              <span
                className={cn("text-sm font-semibold", number === 0 ? "text-primary" : undefined)}
              >
                {name}
              </span>
              {summary ? <span className="text-xs text-muted-foreground">{summary}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ProjectChoice({
  projects,
  chosenId,
  onChoose,
}: {
  readonly projects: ReadonlyArray<StartableProject>;
  readonly chosenId: string;
  readonly onChoose: (projectId: string) => void;
}) {
  const t = useTranslation();
  return (
    <FormField label={t("Project")}>
      <Select
        value={chosenId}
        onValueChange={(projectId) => {
          if (typeof projectId === "string") onChoose(projectId);
        }}
        items={projects.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {projects.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </FormField>
  );
}
