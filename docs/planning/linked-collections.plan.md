# Collegamenti tra record di collezioni diverse

Alfa crea nell’app una collezione **Masking tapes**. Sceglie le colonne tecniche che servono per i nastri e aggiunge un campo **Prodotto** di tipo **Collegamento**, con **Competitor Products** come destinazione. Chi compila una scheda cerca la variante Würth 0992619, la seleziona e ne registra le misure.

| Prodotto collegato | Larghezza | Lunghezza | Spessore |
| ------------------ | --------: | --------: | -------: |
| Würth 0992619      |     18 mm |      50 m |   180 µm |

Cliccando sul prodotto si apre la variante originale, con negozio, prezzi e confezioni. Le colonne tecniche appartengono a _Masking tapes_. Un’altra famiglia di articoli può avere una propria collezione, con colonne diverse e lo stesso tipo di collegamento.

## Come rappresentare il collegamento

**Nell’app, Masking tapes è una nuova tabella.** In SQLite T45 conserva già le definizioni delle tabelle configurate dagli utenti in `collections` e le rispettive righe in `collection_records`. Creare _Masking tapes_ significa aggiungere una definizione e le sue righe a queste strutture. Per il collegamento proposto è sufficiente il formato esistente. [Schema delle collezioni](../../apps/server/src/persistence/Migrations/004_Collections.ts)

Il modello condiviso ha già un campo `records`, oggi selezionabile nell’editor degli step. Il campo conserva l’ID della collezione di destinazione. Ogni riga conserva le chiavi dei record scelti, per esempio `["wurth-0992619"]`. La coppia destinazione e chiave identifica il prodotto anche se lo stesso codice compare altrove. La scheda tecnica mantiene la propria chiave primaria. [Modello dei campi](../../packages/contracts/src/models/Field.ts) · [Modello delle collezioni](../../packages/contracts/src/models/Collection.ts)

Per la prima versione propongo che il campo sia facoltativo e permetta di scegliere più record distinti della stessa collezione. Nel caso Würth basta selezionarne uno. La regola «ogni prodotto può avere una sola scheda tecnica» riguarda l’unicità tra righe diverse e richiederebbe una scelta esplicita per quella collezione. Anche mostrare sul prodotto tutte le schede che lo citano sarebbe una funzione successiva.

## Ordine di sviluppo

1. **Salvare collegamenti validi.** All’aggiunta del campo, il servizio delle collezioni verifica la destinazione. Quando una persona o un agente salva una riga, verifica il permesso di scrivere nella collezione di partenza e di leggere quella di destinazione. Controlla le chiavi selezionate e salva la riga nella stessa transazione. Se una chiave manca, restituisce un errore e conserva la versione precedente. Gli step hanno già un controllo di esistenza e accesso da riusare. [Servizio collezioni](../../apps/server/src/collections/CollectionService.ts) · [Verifica usata dagli step](../../apps/server/src/workflows/WorkflowService.ts)
2. **Mostrare il prodotto a chi può leggerlo.** Per ogni collegamento il server restituisce chiave e titolo corrente, raggruppando le letture per collezione. Lo stesso controllo vale per la pagina della scheda, gli elenchi, i record consultati dentro uno step e gli strumenti degli agenti. Se la destinazione è riservata, il lettore vede _Collegamento riservato_. Poiché il salvataggio attuale sostituisce tutti i valori della riga, il server deve conservare il collegamento nascosto quando quel lettore modifica la larghezza. [Contratto delle collezioni](../../packages/contracts/src/resources/Collections.ts) · [Strumenti degli agenti](../../packages/capabilities/src/collection-tools.ts)
3. **Abilitare il campo nell’editor e nelle schede.** L’editor condiviso offre la scelta dei record quando riceve l’elenco delle collezioni. Passargli le destinazioni disponibili anche dall’editor delle collezioni e mostrare il tipo con l’etichetta _Collegamento_. Nel modulo riusare il selettore degli step, che offre già ricerca e paginazione. Aggiunte e rimozioni diventano effettive con _Salva_. In tabella e nel dettaglio, ogni titolo apre il record originale. Scollegarlo modifica solo la scheda di partenza. [Editor della collezione](../../apps/web/src/components/collections/CollectionEditor.tsx) · [Editor dei campi](../../apps/web/src/components/fields/FieldsEditor.tsx) · [Selettore dei record](../../apps/web/src/components/collections/Records.tsx)

## Come verificare il risultato

- Aggiungere _Prodotto_ a una collezione già popolata **dal browser**, scegliere due prodotti, salvare e riaprire. Seguire il link al Würth, tornare alla scheda e scollegarlo. Verificare che l’altro link e il prodotto originale siano ancora presenti.
- Aprire la stessa scheda **con due utenti** che hanno accessi diversi al catalogo. Verificare che l’utente con accesso limitato possa aggiornare la larghezza senza vedere la chiave del prodotto né perdere il collegamento.
- Salvare un collegamento valido **con gli strumenti Collections**, poi provare a sostituirlo con una chiave inesistente. Rileggere la scheda e verificare che contenga ancora il prodotto valido. Coprire la regola sulle chiavi duplicate nei test del modello. [Scenari di accettazione](./collection-record-links.feature)

## Uso nello step 2 di Alfa

Una volta popolata _Masking tapes_, l’automazione _Competitor prices_ può essere configurata per cercare le schede per larghezza o spessore, seguire il campo _Prodotto_ e proporre il record originale di _Competitor Products_. Così la selezione usa i dati tecnici e il reviewer apre lo stesso prodotto a cui appartengono prezzi e confezioni.
