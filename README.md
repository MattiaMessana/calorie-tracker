# Calorie Tracker

Web app minimale per tracciare le calorie giornaliere. Zero dipendenze esterne — solo Node.js built-in.

## Avvio

```bash
node server.js
```

Apri il browser su [http://localhost:3000](http://localhost:3000).

La porta di default e 3000. Per cambiarla:

```bash
PORT=8080 node server.js
```

## Funzionalita

- Imposta un obiettivo calorico giornaliero
- Aggiungi pasti (colazione, pranzo, cena, spuntino) con descrizione e kcal
- Dashboard con obiettivo, calorie consumate e rimanenti
- Barra di progresso (diventa rossa se sfori l'obiettivo)
- Elimina singole voci o reset dell'intera giornata
- Persistenza su file JSON (`data/db.json`, creato automaticamente)

## API

| Metodo | Endpoint | Body / Params | Descrizione |
|--------|----------|---------------|-------------|
| GET | `/api/state` | - | Stato corrente (obiettivo, entries di oggi, totali) |
| POST | `/api/goal` | `{ goalKcal }` | Imposta obiettivo |
| POST | `/api/entries` | `{ meal, description, kcal }` | Aggiunge un pasto |
| DELETE | `/api/entries?id=UUID` | - | Elimina un pasto |
| POST | `/api/reset` | - | Cancella tutti i pasti di oggi |
