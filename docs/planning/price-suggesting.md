Jira Task
• Determine selling price (SP):
the selling prices (SP) for new items should be proposed. It doesn’t have to be exact – the goal is a reasonable price recommendation that will be reviewed afterwards.
The following must be considered for the SP proposal:
◦ Alfa prices: Compare the product group of the new item with similar products or products from the same product group and use their selling prices as reference (from Datanorm document) alfa-datanorm (4).001
◦ LC
◦ CM targets: Percentage targets for the contribution margin per PU (see table)
◦ CM in € must always be positive
◦ Competitor prices: Ideally cheaper than the competition:
▪ approx. 20% below Förch / Würth / BTI
▪ cheaper than or equal to Amazon
◦ Rounding: Round prices to €0.05 or €0.09 (except for SP below €1.20)
CM targets per PU

| PU  | Ideal CM % | Min. CM % |
| --- | ---------- | --------- |
| PU0 | from 50%   | 42%       |
| PU1 | from 46%   | 40%       |
| PU2 | from 43%   | 35%       |
| PU3 | from 35%   | 32%       |
| PU4 | from 32%   | 30%       |

NOTE: B2B pricing is calculated net. Competitor prices must also be compared net.
→ Result: SP proposal that takes all of the points above into account as well as possible.

I hope this helps determine SP. Otherwise let me know or we can discuss it on thuesday
•
here is the calculation for the “example offer” and “technical information”.
PUs: Recommendations based on benchmark and supplier quotes
SP/PU0: Based on benchmark competitors and a defined margin (I still need to clarify this)

## Agreed workflow

The former step 3 (sales unit definition) and step 4 (price calculation) become one step named **Price and margin proposal**. A dedicated agent proposes packaging units and selling prices, with the calculated margins available during the person's review. The next step is the management decision on whether to authorise negotiation.

1. **Step 1 — Data extraction and collection:** collect the product variants, supplier prices and terms, packaging and shipping costs, and units of measure.
2. **Step 2 — Market analysis:** collect comparable competitor offers, including packaging quantities and prices per unit of measure. Prices used for the proposal must be net. The configured automation currently collects Amazon offers; the client's request also includes other competitors.
3. **Step 3 — Price and margin proposal:** use the inputs from steps 1 and 2, together with Alfa's prices for comparable products from Datanorm. Apply the client's documented minimum and ideal CM targets for each PU from the table above. Propose suitable packaging units from supplier offers and market benchmarks. For each variant × packaging unit, show the proposed selling price, price per unit, costs, achieved margin in euros and percent, comparison with those targets, competitor references and reasoning. The person reviews and can adjust the proposal; any price changes must be reflected in the margins before approval. Approval sends the proposal to management.
4. **Step 4 — Management decision:** review the approved proposal and decide whether to authorise negotiation.

The minimum and ideal margin percentages are already supplied by the client in the table above. They are rules applied by the pricing agent; the user does not need to enter them again, and no margin-target field is added to step 1. Step 3 calculates the achieved margin for each proposal and compares it with the corresponding PU targets. The cost basis used to calculate the achieved margin remains a separate clarification, as described below.

LC remains undefined. The product owner does not know what it means in the client's request; its definition must be confirmed with the client before it is used in the calculations.

Configured in Alfa workflow version 7: the unified proposal step, the Alfa pricing advisor agent and its automation, and the following management-decision step. The two open items use this version with their existing values, attachments and history preserved. The agent's `pricing.py` file performs decimal calculations and applies the documented PU targets. After changing a price or quantity, the person reruns the automation to update the dependent amounts before approving; the agent clears the approval when recalculating and leaves it to the person.

The current calculation is explicitly provisional: its percentage reproduces the supplied spreadsheets' purchase-cost formula, while euro margin includes the documented packing and freight costs. LC and commercial rounding remain unresolved. Arithmetic was checked against 14 packaging-unit calculations from the five supplied workbooks, and the table, manual approval and management handoff were verified in an isolated browser instance. No agent or scraping automation was run as part of this setup.

## Proposed SP logic

1. Compute the minimum price from the cost and the client's documented minimum CM for that PU.
2. Compute the ceiling from competitors: ~20% below Förch / Würth / BTI, and not above Amazon (all net).
3. Use Alfa's prices for the same product group as a reference within that range.
4. Aim for the client's documented ideal CM for that PU if the ceiling allows it, otherwise the highest price under the ceiling.
5. Apply the client's rounding rule for SP of €1.20 or more, then check the resulting margins again. The exact meaning of rounding to €0.05 or €0.09 needs confirmation.
6. If the minimum price is above the ceiling, flag the item as not competitive, with the numbers, for the person's review.

## Questions and answers

1. **What is LC?** Still unknown to the product owner. Ask the client to define it; the earlier suggestion of landed cost was an unconfirmed interpretation.
2. **How is the achieved margin percentage calculated?** The minimum and ideal percentages are already defined in the client's CM targets table and are applied automatically per PU. The remaining question concerns the calculation basis: the spreadsheet's percentage ignores freight and packing and divides by the selling price, while its euro margin includes those costs. Confirm which costs the achieved CM percentage should include.
3. **Which rule has priority when the competitor ceiling conflicts with the minimum margin?** Still open. The proposed behaviour above exposes the conflict for review.
4. **What is PU0?** The spreadsheet has VE1 to VE3; the task has PU0 to PU4. Datanorm analysis below identifies VE0 as the single base unit.
5. **Where does Datanorm come from, how often is it updated, and how is the product group matched?** Source/update policy and group mapping remain to be confirmed; the file has no populated product-group codes.
6. **How should gross competitor prices be converted to net?** The examples below use division by 1.19, but not consistently. Confirm the rule for the offers used in the proposal.
7. **Should Förch be included?** It is named in the client's pricing request and already appears in the hanger-bolt calculation below; the configured automation currently collects Amazon offers.
8. **Which CM targets apply to PU0?** The supplied table defines a minimum of 42% and an ideal target from 50%. Use these documented values directly when proposing prices.
9. **What exactly does rounding to €0.05 or €0.09 mean?** Confirm the intended price endings or increments; the exception for prices below €1.20 is already stated in the client's request.

## Findings from the five calculations and Datanorm

The five product calculations (building protection mat, flat roof sealant, green roof substrate, installation cable, hanger bolt) and the Datanorm file answer several of the questions above and change some of our assumptions.

### Answers to our questions

- Net prices (Q6): they convert gross shop prices to net by dividing by 1.19, as in the cable sheet. The rule isn't applied everywhere: some Reichelt prices are left as they are.
- PU0 (Q4): in Datanorm, VE0 is the single base unit (1 m, 1 kg, 1 piece). 807 articles have it, and 39 go up to VE4.
- Revenue potential: it is planned sales quantity × SP of PU1 (formula in the cable and hanger bolt sheets). In the first spreadsheet it was only typed in.

### Assumptions that change

- The supplier discount isn't fixed. The net purchase price is ×0.98, ×0.97, unchanged, plus €0.008, or typed in, depending on the product. It comes from each offer's payment terms.
- The unit isn't always the piece. Prices and PU contents are per m², kg, litre, metre or pack of 100. Competitor prices are compared per unit too (€/m², €/kg, €/l, €/m).
- Freight is worked out by hand on every row. Carton freight on PU1 is sometimes included and sometimes not; PU3 can count two cartons; one cell adds a stray 3.52. Pallet freight is built up as rate × weight + 8.45% toll + 9% diesel surcharge + €1 pallet exchange + €3 insurance.
- Country markups differ: Austria is the same as Germany or +7.5%, depending on the product.
- Shipping surcharges are paid by the customer: in the substrate sheet the surcharge (€6.99 or €34.95) is added back to the € CM.
- Product group codes exist ("104 Fastening technology", "103 Screws", "1269 Other screws") in the calculations, not in Datanorm.
- Competitors go well beyond Amazon: DEG Süd, Bausep, Contorion, Hornbach, Kemmler, OBI, Toom, Bauhaus, Reichelt, Conrad, Reca and others. Förch is already in the hanger bolt sheet.

### Datanorm

- 6,863 records (one per article and PU), 1,172 product families. Prices are net, in cents, per PU. EAN per PU.
- No product group and no discount group: those fields are empty. Matching "the same product group" needs a mapping from their ERP or PIM, or matching on article family and text.
- Broken encoding: 1,740 short texts have lost their umlauts. We need the original file in its own character set.
- Some PU texts are wrong: the green roof substrate shows "1 l" for a 25-litre bag.

### A ready-made test set

The five products are already in Datanorm, so their final selling prices are known. They differ from the SPs in the calculations by up to about 40%: the cable's PU2 is €250 in the sheet and €360 in Datanorm. That makes them five benchmark cases for the SP proposal: the calculation as input, the Datanorm prices as expected output.
