# language: it
# Contesto: chi gestisce una scheda tecnica vuole riutilizzare i prodotti già presenti in catalogo.
# Scelte proposte: una collezione di destinazione per campo e più record selezionabili.
# Tags: @next identifica i comportamenti proposti per la prima versione.

@next
Funzionalità: Collegare record di collezioni diverse

  Regola: Ogni campo Collegamento identifica la collezione in cui scegliere

    Scenario: Configurare il campo su una collezione già popolata
      Dato che «Nastri per mascheratura» contiene già delle schede
      Quando un amministratore aggiunge il campo «Prodotto» di tipo Collegamento e sceglie «Prodotti concorrenti»
      Allora chi modifica una scheda può scegliere tra i record di «Prodotti concorrenti»
      E può completare in seguito il campo sulle schede già presenti

  Regola: Un collegamento apre il record originale

    Scenario: Collegare prodotti esistenti a una scheda
      Dato che posso modificare una scheda e leggere i prodotti del catalogo
      Quando collego due prodotti esistenti e salvo la scheda
      Allora riaprendo la scheda trovo entrambi i prodotti una sola volta
      E posso aprire la variante Würth 0992619 nel catalogo originale

    Scenario: Rimuovere un collegamento
      Dato che una scheda collega due prodotti
      Quando scollego il primo prodotto e salvo
      Allora la scheda contiene ancora il collegamento al secondo prodotto
      E il primo prodotto è ancora consultabile nel catalogo

  Regola: Persone e agenti collegano solo record esistenti e leggibili

    Scenario: Un agente associa una chiave inesistente
      Dato che un agente può salvare una scheda e leggere il catalogo di destinazione
      Quando tenta di salvare una modifica con una chiave assente da quel catalogo
      Allora il salvataggio viene rifiutato per intero
      E la scheda conserva i valori precedenti

    Scenario: Un lettore ha accesso alla scheda ma il catalogo collegato è privato
      Dato che posso leggere una scheda collegata a un prodotto riservato
      E non ho accesso al catalogo di quel prodotto
      Quando consulto la scheda
      Allora il campo segnala che la destinazione è riservata
      E la chiave e il titolo del prodotto restano riservati

    Scenario: Modificare un altro campo con un collegamento riservato
      Dato che posso modificare una scheda con un collegamento che non posso consultare
      Quando aggiorno la larghezza e salvo la scheda
      Allora un lettore autorizzato ai due record vede la nuova larghezza e il collegamento precedente
