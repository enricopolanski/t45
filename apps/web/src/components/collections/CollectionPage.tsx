import type { Collection } from "@t45/contracts/models/Collection";
import { defaultValues } from "@t45/contracts/models/Field";
import { resolveRecordDisplay } from "@t45/contracts/models/Layout";
import type { CollectionRecordView } from "@t45/contracts/resources/Collections";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { describeFailure } from "../../lib/failures";
import { api } from "../../rpc/api";
import { useIsAdmin } from "../../state/session";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/error-text";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tabs, TabsList, TabsTab } from "../ui/tabs";
import { WorkFrame } from "../work/WorkFrame";
import { RecordCards } from "./RecordDisplay";
import { RecordCount, RecordFilterBar, RecordPager, useRecordSearch } from "./RecordSearch";
import { RecordDialog, RecordTable } from "./Records";

/**
 * A collection's records as a table or cards: found by their words and filters, counted, shown
 * `page` by page, opened on their own page, and added. A new search starts on the first page.
 */
export function CollectionPage({
  collectionId,
  page,
  onPage,
}: {
  readonly collectionId: string;
  readonly page: number;
  readonly onPage: (page: number) => void;
}) {
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [collection, setCollection] = useState<Collection | null>(null);
  const { text, filters, found, filterChoices, refresh, ...search } = useRecordSearch(
    collection,
    page,
  );
  const setText = (next: string) => {
    search.setText(next);
    onPage(1);
  };
  const setFilters = (next: typeof filters) => {
    search.setFilters(next);
    onPage(1);
  };
  const [failure, setError] = useState<string | null>(null);
  const error = failure ?? search.error;
  const [isReordering, setIsReordering] = useState(false);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [view, setView] = useState<"table" | "cards" | null>(null);

  useEffect(() => {
    let current = true;
    void api("collections.get", { collectionId }).then(
      (loaded) => current && setCollection(loaded),
      (cause: unknown) => current && setError(describeFailure(cause)),
    );
    return () => {
      current = false;
    };
  }, [collectionId]);

  const reorderColumns = (columnOrder: ReadonlyArray<string>) => {
    setIsSavingOrder(true);
    setError(null);
    void api("collections.reorderColumns", { collectionId, columnOrder }).then(
      (saved) => {
        setCollection(saved);
        setIsSavingOrder(false);
      },
      (cause: unknown) => {
        setError(describeFailure(cause));
        setIsSavingOrder(false);
      },
    );
  };

  if (collection === null)
    return (
      <WorkFrame title="Collection">
        <p role={error === null ? undefined : "alert"} className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      </WorkFrame>
    );
  const shownView = view ?? resolveRecordDisplay(collection).defaultView;
  const openRecord = (record: CollectionRecordView) =>
    void navigate({
      to: "/settings/collections/$collectionId/records/$recordKey",
      params: { collectionId, recordKey: record.key },
    });
  return (
    <WorkFrame
      title={collection.title}
      width="full"
      actions={
        <>
          {isAdmin ? (
            <Button
              size="sm"
              variant="outline"
              render={
                <Link to="/settings/collections/$collectionId/edit" params={{ collectionId }} />
              }
            >
              Edit collection
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setIsAdding(true)}>
            <PlusIcon />
            New record
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-4">
        <Input
          type="search"
          aria-label="Search records"
          placeholder="Search records"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Tabs
          value={shownView}
          onValueChange={(next) => setView(next === "cards" ? "cards" : "table")}
        >
          <TabsList aria-label="Show records as">
            <TabsTab value="table">Table</TabsTab>
            <TabsTab value="cards">Grid</TabsTab>
          </TabsList>
        </Tabs>
        {/* A layout's columns replace the column order, so it reorders only without them. */}
        {isAdmin && shownView === "table" && collection.layout?.table?.columns === undefined ? (
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Switch size="sm" checked={isReordering} onCheckedChange={setIsReordering} />
            Reorder
          </label>
        ) : null}
      </div>
      <RecordFilterBar
        collection={collection}
        filters={filters}
        filterChoices={filterChoices}
        onChange={setFilters}
      />
      {error && <ErrorText text={error} />}
      {found === null ? null : found.totalCount === 0 ? (
        <p className="text-sm text-muted-foreground">No records yet.</p>
      ) : found.matchCount === 0 ? (
        <p className="text-sm text-muted-foreground">No record matches.</p>
      ) : (
        <RecordCount matchCount={found.matchCount} totalCount={found.totalCount} />
      )}
      {found !== null && found.records.length > 0 && shownView === "cards" ? (
        <RecordCards
          label="Records"
          collection={collection}
          records={found.records}
          onOpen={openRecord}
        />
      ) : null}
      {found !== null && (found.records.length > 0 || isReordering) && shownView === "table" ? (
        <RecordTable
          label="Records"
          collection={collection}
          records={found.records}
          onOpen={openRecord}
          reorder={
            isAdmin && isReordering
              ? { disabled: isSavingOrder, onChange: reorderColumns }
              : undefined
          }
        />
      ) : null}
      {found === null ? null : (
        <RecordPager page={page} matchCount={found.matchCount} onPage={onPage} />
      )}
      {isAdding ? (
        <RecordDialog
          collection={collection}
          record={{ values: defaultValues(collection.fields), files: [] }}
          onClose={() => setIsAdding(false)}
          onSaved={() => {
            setIsAdding(false);
            refresh();
          }}
        />
      ) : null}
    </WorkFrame>
  );
}
