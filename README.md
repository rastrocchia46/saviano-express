# Saviano Express · sito per la gara del 27 settembre 2026

**Versione: GitHub Pages + Supabase (backend condiviso).** Il sito è pronto per essere caricato su un nuovo repository GitHub; la gara LIVE non è operativa finché un organizzatore non configura **un progetto Supabase**, esegue lo SQL e aggiunge URL e Publishable Key in `site-config.js`. La pubblicazione su GitHub Pages non esegue lo SQL da sola. La vecchia demo senza sincronizzazione è in `demo.html` ed è etichettata come tale.

## Funzioni implementate

- Percorso in cinque tappe: indovinelli e liste inizialmente nascosti; accessibili ai giocatori dalla partenza della propria squadra. Pubblicazione per gli spettatori dopo 30 minuti dall'inizio della prima squadra, oppure manualmente dalla regia. La pubblicazione sui social esterni **non è automatizzata**.
- Prima tappa con **12 oggetti**, le successive opzionalmente con zero o 12 oggetti. −5 minuti per oggetto recuperato, +5 per mancante; malus +15 e +20 minuti per aiuti ottenuti rispettivamente dopo 25/50 minuti dall'inizio della propria tappa.
- Squadra e commissario con codici separati; la squadra spunta oggetti e chiede aiuti, il commissario avvia e convalida la prova. La regia crea squadre, configura tappe e controlla la gara. I tempi e i permessi vengono verificati dal database: cambiare ruolo dal browser **non** assegna privilegi.
- Classifica sincronizzata circa ogni 6 s, calcolata dai tempi **definitivi** delle tappe convalidate. Prima il numero di prove concluse, poi il tempo corretto a parità di prove: la classifica parziale **non** proclama il vincitore.
- Dopo la convalida delle prime quattro tappe per tutte le squadre, il pulsante **Programma le partenze** della regia assegna i distacchi per la quinta. La regia avvia la programmazione **quando le squadre sono pronte**, dato che parte dal momento della pressione del pulsante con 30 s di preparazione. Il commissario avvia la prova non prima del proprio orario.
- GPS facoltativo dal telefono della squadra o del commissario su HTTPS. Le coordinate precise sono visibili alla regia e alla squadra stessa; il pubblico vede un segnaposto approssimato (griglia ~100 m) **solo** su consenso separato, dopo 30 minuti di tappa in corso e **mai durante la finale**. Gli aggiornamenti sulla mappa sono mostrati fino a 90 s dopo l'ultimo rilevamento. La posizione **non** è un controllo affidabile per emergenze.

## 1. Preparare Supabase (una sola volta)

1. Vai su [Supabase](https://supabase.com/dashboard) e crea un **nuovo progetto dedicato** a Saviano Express. Conserva la password del progetto fuori da GitHub.
2. Nel progetto, apri **SQL Editor → New query**; incolla **tutto** `backend/setup.sql`, quindi premi **Run** una sola volta. Non ripetere lo script sullo stesso database: crea tabelle e funzioni.
3. Crea **una sola credenziale admin segreta**, lunga almeno 24 caratteri casuali, in una **nuova query del SQL Editor**, sostituendo SOLO il testo fra apici nel comando seguente:

   ```sql
   insert into public.sx_identity(role,code_hash) values
   ('admin',encode(extensions.digest('INCOLLA_QUI_UNA_PASSPHRASE_RANDOM_DI_ALMENO_24_CARATTERI','sha256'),'hex'));
   ```

   **Non** committare o inviare in chat quel codice. Chi conosce questa credenziale può gestire tutto l'evento. Lo inserirai nel form «Accedi» del sito una volta pubblicato.
4. Vai in **Project Settings → API Keys** (oppure **Connect**). Copia **Project URL** e la **Publishable key** (`sb_publishable_...`), non la Secret key / service_role key. Inseriscile nel file `site-config.js`:

   ```js
   window.SAVIANO_CONFIG = Object.freeze({
     supabaseUrl: 'https://IDPROGETTO.supabase.co',
     publishableKey: 'sb_publishable_LA_TUA_CHIAVE_PUBBLICA',
     refreshMs: 6000
   });
   ```

   URL e Publishable Key sono **pubblici per definizione**, e possono stare nel repository. Il backend impedisce la lettura diretta delle tabelle ai client anonimi/autenticati e passa soltanto dalle funzioni controllate. **Mai** caricare codici squadra/commissario/regia, password database o Secret/Service Role Key in GitHub, in `site-config.js` o in file pubblicati.
5. Nel SQL Editor puoi verificare che non sia possibile leggere direttamente le tabelle con queste istruzioni (devono dare `false`):

   ```sql
   select has_table_privilege('anon','public.sx_identity','SELECT') as anon_identity,
          has_table_privilege('anon','public.sx_progress','SELECT') as anon_progress,
          has_table_privilege('anon','public.sx_locations','SELECT') as anon_gps;
   ```

## 2. Pubblicare su GitHub Pages (come gli altri siti)

1. Crea su GitHub un nuovo repository, ad esempio `saviano-express`. Evita di sovrascrivere i repository già esistenti.
2. Apri lo ZIP e **carica nella root del repository i file contenuti nella cartella `saviano-express`**, non la cartella esterna. In root devono comparire direttamente `index.html`, `app.js`, `site-config.js`, `assets/`, `backend/`, `README.md`, `.nojekyll`. Carica lo `site-config.js` aggiornato con **solo** URL e Publishable Key.
3. In **Settings → Pages → Build and deployment** seleziona `Deploy from a branch` → `main` → `/(root)` → `Save`.
4. Dopo il deploy, il sito seguirà lo schema `https://NOMEUTENTE.github.io/saviano-express/` (sostituisci username e nome del repository con quelli effettivi). Apri la pagina da smartphone in HTTPS, non con `file://`.
5. Accedi come regia, registra le squadre e annota i due codici che la pagina mostra **una sola volta al momento della creazione**. Distribuisci il codice squadra e quello commissario separatamente e in privato. Le persone del pubblico **non** devono conoscere quei codici.
6. Prima del 27 settembre inserisci i testi veri degli indovinelli e la lista degli oggetti, quindi verifica le prove in condizioni di test con **almeno due telefoni distinti**. Dopo la prova generale configura un **nuovo progetto Supabase pulito** oppure elimina manualmente i dati di prova nel SQL Editor, dopo esserti assicurato di aver salvato il materiale corretto per la gara. Il sito non include un pulsante di reset che potrebbe cancellare la gara per errore.

## 3. Procedura durante la giornata

- La regia salva la tappa e la apre. Quando una squadra riceve la busta, il suo commissario avvia la prova. Il suo cronometro è indipendente da quello delle altre squadre.
- La squadra marca gli oggetti trovati. La checklist è provvisoria; alla conclusione il commissario verifica fisicamente gli oggetti e convalida la prova dal proprio telefono.
- Dopo 25/50 minuti la squadra può chiedere gli aiuti nell'interfaccia; il commissario li concede e il backend registra i malus.
- Prima della quinta tappa, con tutte le prime quattro prove convalidate, la regia apre la quinta e preme **Programma le partenze** quando le squadre sono tutte pronte per partire. Gli orari compaiono nei dispositivi dei commissari.
- Un telefono per squadra può attivare il GPS e tenerlo acceso durante la gara. L'esattezza e la continuità dipendono da permessi, copertura e sospensione del browser in background. Il sito non può forzare un telefono a condividere la posizione.

## 4. Controlli e limitazioni importanti

- **GPS e privacy**: informa preventivamente tutti i partecipanti e chi porta il telefono circa finalità, visibilità, durata e scelta facoltativa; fai attenzione particolare ai minori. La condivisione pubblica approssimata è disattivata di default. La posizione precisa non è disponibile al pubblico; non memorizzare lo storico degli spostamenti senza necessità. Al termine dell'evento premi «Interrompi e cancella GPS» su ciascun dispositivo, poi puoi cancellare centralmente le coordinate residue dal SQL Editor con:

  ```sql
  update public.sx_locations set lat=null,lng=null,accuracy=null,updated_at=null,public_opt_in=false;
  delete from public.sx_sessions;
  ```

  Se vuoi eliminare **anche** ogni dato dell'evento, consulta prima la tua politica di conservazione; la cancellazione completa di squadre, risultati e credenziali è irreversibile.
- **Sincronizzazione**: polling ogni 6 s, non un canale WebSocket push. L'orario registrato dal server è ufficiale. Per la gara reale prepara una connessione mobile affidabile, power bank e un registro cartaceo dei tempi in caso di disservizi.
- **Conflitti di scrittura**: il server applica le transizioni in ordine e i controlli di ruolo. Se due telefoni spuntano lo stesso oggetto contemporaneamente, vale l'ultima operazione ricevuta dal server; il commissario deve controllare il risultato prima della convalida.
- **Sicurezza**: URL e Publishable Key sono nel frontend perché non sono segreti. Codici di accesso e token non vanno condivisi. Il database non permette SELECT diretto alle tabelle: controlla l'esito delle verifiche SQL e non alterare grant/RLS senza una revisione.
- **Risorse esterne**: Leaflet, font, tiles OpenStreetMap e libreria Supabase caricati da Internet; il sito richiede la rete.
- **Backup**: in assenza del backend online la pagina si limita a mostrare un messaggio di connessione. Non si creano tempi ufficiali fittizi e non si simula una sincronizzazione inesistente.

## 5. Struttura del progetto

```
index.html          Pagina pubblica e interfacce squadra/commissario/regia
app.js              Interazione client e polling della gara
site-config.js      Solo URL e Publishable Key di Supabase
assets/base.css     Stile originale pergamena, verde e arancione
assets/live.css     Estensioni grafiche responsive
backend/setup.sql   Tabelle, accessi per ruolo, calcolo e convalida server
README.md           Questo manuale
.nojekyll           Pubblicazione statica GitHub Pages
demo.html           Vecchia simulazione locale, NON collegata alla gara reale
```

Per problemi di sincronizzazione controlla la console del browser, l'URL della Project API, l'esecuzione dello SQL e le impostazioni del progetto Supabase. Evita di postare screenshot con codici di accesso visibili.
