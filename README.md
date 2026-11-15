# Google Fotos sichern

Sortiert einen Google-Takeout-Export nach Jahr und Monat auf eine Festplatte und trägt dabei das richtige Aufnahmedatum ein. Die Fotos bleiben auf dem eigenen Computer; es wird nichts hochgeladen.

- **WebApp (Edge oder Chrome):** https://jensottolanghof.github.io/Google-Fotos-Backup/
- **Windows-Programm, ohne Installation:** [Fotos-Backup.exe herunterladen](https://github.com/JensOttoLanghof/Google-Fotos-Backup/releases/latest/download/Fotos-Backup.exe)

## Ablauf

1. **Export bei Google anfordern**
   1. [takeout.google.com](https://takeout.google.com/) öffnen und mit dem Konto anmelden, dessen Fotos gesichert werden sollen.
   2. „Auswahl aufheben“ anklicken, dann nur „Google Fotos“ anhaken.
   3. Auf „Alle Fotoalben eingeschlossen“ klicken und nur die gewünschten Jahre wählen, z. B. „Fotos von 2026“. Für ein oder zwei Monate das laufende Jahr wählen – bereits gesicherte Fotos werden übersprungen.
   4. „Nächster Schritt“: Downloadlink per E-Mail, Dateityp **.zip**, Größe 50 GB. Häufigkeit: einmalig oder „Alle 2 Monate für 1 Jahr“.
   5. „Export erstellen“. Google schickt eine E-Mail mit dem Download-Link.
2. **ZIP-Dateien herunterladen**, nicht entpacken.
3. **WebApp oder Programm öffnen**, ZIP-Dateien und Zielordner auswählen, „Sicherung starten“.

Immer denselben Zielordner verwenden. Darin entstehen Ordner wie `2026\03 März`, dazu `Ohne Datum` für Dateien ohne erkennbares Datum und die Datei `_sicherung-index.json` (Liste der bereits gesicherten Dateien – bitte nicht löschen).

## Woher das Datum kommt

| Fall | Aufnahmedatum |
| --- | --- |
| Foto hat bereits ein Aufnahmedatum (EXIF) | bleibt unverändert |
| Dateiname enthält ein Datum (`IMG-20240115-WA0001.jpg`, `IMG_20240115_183000.jpg`, `VID-…`, `Screenshot_…`) | Datum aus dem Namen; fehlt die Uhrzeit, kommt sie aus der Takeout-JSON, sonst 12:00 Uhr |
| sonst | Datum aus der Takeout-JSON (`photoTakenTime`) |

Das Datum wird in JPEG-Fotos (EXIF) und in MP4/MOV-Videos geschrieben. Andere Formate (PNG, GIF, HEIC …) werden unverändert kopiert und nur richtig einsortiert.

## WebApp oder Windows-Programm?

| | WebApp | Windows-Programm |
| --- | --- | --- |
| Installation | keine | keine (eine Datei) |
| Browser | Edge, Chrome | beliebig, auch Firefox |
| Aufnahmedatum in der Datei | ja | ja |
| Dateidatum („Änderungsdatum“ im Explorer) | nein, technisch nicht möglich | ja |

Das Programm ist nicht signiert. Windows zeigt beim ersten Start „Der Computer wurde durch Windows geschützt“ – auf „Weitere Informationen“ und „Trotzdem ausführen“ klicken.

## Einmalige Einrichtung des Repositorys

Unter **Settings → Pages → Build and deployment → Source** „GitHub Actions“ auswählen. Danach veröffentlicht jeder Push auf `main` die WebApp und baut eine neue `Fotos-Backup.exe`.

## Entwicklung

Benötigt [Bun](https://bun.sh).

```
bun install
bun test            # Tests
bun run build       # dist/index.html
bun run start       # Programm lokal starten
bun src/exe.js --zips takeout-001.zip takeout-002.zip --ziel E:\Fotos   # ohne Oberfläche
```
