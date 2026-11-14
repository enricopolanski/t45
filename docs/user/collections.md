# Collections

A collection keeps data that people and agents reuse across tasks, such as product listings checked on a shop. Admins open it under **Settings › Collections**.

An admin creates a collection with **New collection**: a title, fields defined like a step's fields, and a primary key, the text field whose value identifies a record. Admins and the members a collection lists see and edit its records; nobody else sees the collection.

Use **New record** to add a record, and click a record to change it. Saving a record whose key the collection already holds replaces that record, files included. Search finds records by any of their text values.

Turn off **Show in table** on a field to keep it out of the records table; it still shows when you open a record. Fields in a group with multiple entries work the same way: an entry's hidden fields show under its **Details**.

Admins can turn on **Reorder** above the collection's table and use the arrows above each column to move it left or right. Each move saves automatically, and the same column order appears wherever the collection's records are shown, including steps.

Once a collection has records, its admin can add fields and change which show in the table, but can't change or remove the fields it has or its primary key.

## Records in a step

A step field of type **Collection records** lists the records of one collection that belong to the ticket, in the collection's own table. **Link record** picks one the collection holds, **New record** adds one to the collection and links it, and clicking a record edits it in the collection, for every ticket that links it. Unlinking a record leaves it in the collection. Whoever sees the step sees the records it links; linking, adding and editing them needs access to the collection.

## Agents

Give an agent the **Collections** capability to let it look records up and save them. It saves to any collection. In a chat it reads only the collections of the person chatting; in an automation it reads every collection.
