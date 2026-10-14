# Hautritual – Korean-Skincare-Tracker

Private Web-App für zwei Profile (**Bibi** und **Bubu**, ohne Passwort). Läuft als Google-Apps-Script-Web-App,
Daten liegen in einer Google-Tabelle, auf dem iPhone als Homescreen-Icon nutzbar.

## Dateien

| Datei | Inhalt |
|---|---|
| `Code.gs` | Backend: Schema, `setupSchema()`, API für `google.script.run`, Sperre für gleichzeitiges Speichern |
| `Index.html` | UI-Gerüst und komplettes Stylesheet |
| `JavaScript.html` | Client-Logik (Vanilla JS): alle Screens, Timer, Fehlerbehandlung, lokaler Demo-Modus |
| `appsscript.json` | Manifest (Zeitzone Europe/Berlin, Web-App „Jeder“, ausgeführt als Besitzer) |
| `launcher/` | Optional: Starter-Seite mit eigenem Homescreen-Icon (`apple-touch-icon`, Manifest) |

## Einrichtung (ca. 5 Minuten)

1. Auf [script.google.com](https://script.google.com) ein neues Projekt anlegen.
2. Dateien anlegen und Inhalte hineinkopieren:
   - `Code.gs` → Skriptdatei `Code`
   - `Index.html` → HTML-Datei `Index`
   - `JavaScript.html` → HTML-Datei `JavaScript`
   - `appsscript.json`: unter *Projekteinstellungen* „Manifestdatei anzeigen“ aktivieren, dann Inhalt ersetzen.
3. **Tabelle verbinden** (eine Variante wählen):
   - *Vorhandene Tabelle:* unter *Projekteinstellungen → Script-Properties* `SHEET_ID` = ID aus der Tabellen-URL
     (`docs.google.com/spreadsheets/d/<ID>/edit`).
   - *Automatisch:* nichts eintragen – `setupSchema()` legt die Tabelle „Hautritual – Daten“ an und speichert die ID.
4. Im Editor die Funktion **`setupSchema`** auswählen und ausführen (Berechtigungen bestätigen).
   Sie legt die Blätter `profiles`, `routineSteps`, `products`, `logs`, `skinLog` mit Kopfzeilen und die beiden Profile an.
   Sie ist idempotent und läuft beim ersten App-Start ohnehin automatisch.
5. **Bereitstellen → Neue Bereitstellung → Web-App**
   - Ausführen als: **Ich**
   - Zugriff: **Jeder** (ohne Google-Login)
6. Die `/exec`-URL in Safari auf dem iPhone öffnen → Teilen → **Zum Home-Bildschirm**.

Optional: Script-Property `ICON_URL` mit einer öffentlichen PNG-URL setzt das Favicon.

## Homescreen-Icon auf dem iPhone

Apps Script liefert die App in einem iframe aus und erlaubt keinen eigenen `apple-touch-icon`-Link auf der äußeren Seite.
`Code.gs` setzt per `addMetaTag()` alles, was möglich ist (`apple-mobile-web-app-capable`, Viewport) –
die App öffnet sich damit ohne Safari-Leisten. Das Icon ist dann aber ein Screenshot der Seite.

Für das **eigene Icon** den Ordner `launcher/` irgendwo statisch hosten (z. B. GitHub Pages), in `launcher/index.html`
`WEBAPP_URL` durch die `/exec`-URL ersetzen und *diese* Seite zum Home-Bildschirm hinzufügen. Sie bringt Icon und
Manifest mit und bettet die Web-App ein (`Code.gs` erlaubt das Einbetten).

## Datenmodell

Alle Zellen sind als Text formatiert; Listen/Objekte werden als JSON gespeichert.

| Blatt | Spalten |
|---|---|
| `profiles` | id, name, skinType, goals (JSON), onboarded, createdAt, updatedAt |
| `routineSteps` | profileId, stepKey, timeOfDay (`morning`/`evening`), frequency (`daily` oder `days:1,4` mit 0 = So … 6 = Sa), productId, updatedAt |
| `products` | id, name, brand, stepKey, openedAt, paoMonths, sharedWith (JSON), notes (JSON), remainingPercent, createdAt, updatedAt |
| `logs` | profileId, date, stepKey, timeOfDay, done, updatedAt |
| `skinLog` | profileId, date, rating (1–5), text, updatedAt |

`notes` = `{amount, order, method, application, contactTime, usageDuration, usageEnd, freeText}`.

## Getroffene Standardentscheidungen

Im Code jeweils mit `STANDARD:` markiert:

- `logs` hat zusätzlich `timeOfDay`, weil derselbe Schritt morgens und abends getrennt abgehakt wird.
- Häufigkeit gilt pro Schritt für beide Tageszeiten.
- Vorschlag: Basis = Reinigung, Toner, Feuchtigkeitscreme, Sonnenschutz; Hauttyp und Ziele ergänzen Schritte.
  Peeling 2× pro Woche (Di, Fr), bei empfindlicher Haut 1× (Fr). Tuchmaske sonntags. Sonnenschutz nur morgens.
- Kalender und Vergangenheit werden mit der *aktuellen* Routine bewertet (Routineänderungen werden nicht historisiert).
- Die App lädt Logs und Hauttagebuch der letzten 400 Tage.
- Ohne `SHEET_ID` legt `setupSchema()` eine neue Tabelle an.
- Der Timer-Signalton wiederholt sich bis zu 1 Minute lang, bis „Okay“ getippt wird.

## Timer – Grenzen von iOS

- Der Ton kommt über Web Audio und wird beim ersten Tippen freigeschaltet. Er erklingt nur, **solange die App offen ist**,
  und ist bei aktivem Lautlos-Schalter stumm. Keine Push-Benachrichtigung, keine Vibration (iOS Safari unterstützt beides hier nicht).
- Der Timer rechnet mit der Endzeit statt mit Ticks: Nach dem Zurückwechseln in die App stimmt die Restzeit, und ein
  inzwischen abgelaufener Timer wird sofort angezeigt. Auch ein Neuladen übersteht er (gespeichert in `localStorage`).

## Lokal ansehen (ohne Google)

`JavaScript.html` bringt einen Demo-Modus mit, der nur greift, wenn `google.script.run` fehlt: Daten liegen dann im
`localStorage` des Browsers, mit Beispielprodukten. Zum Ansehen den Include in `Index.html` durch den Inhalt von
`JavaScript.html` ersetzen und die Datei im Browser öffnen, z. B.:

```bash
python3 -c "s=open('Index.html').read().replace(\"<?!= include('JavaScript'); ?>\", open('JavaScript.html').read()); open('/tmp/vorschau.html','w').write(s)"
```
