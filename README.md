# Preset Decoder: Lightroom preseto atkūrimas iš nuotraukos

Į puslapį įkeliate nuotrauką, kurią apdorojote Lightroom. Programa perskaito **visą** jos metadata
(EXIF, XMP, IPTC, GPS, ICC, JFIF, gamintojo duomenis) ir iš Lightroom / Camera Raw įrašytų
apdorojimo nustatymų (`crs:`) sukuria **Lightroom presetą**, kurį galite atsisiųsti ir importuoti atgal.

## Galimybės

- **Prisijungimas el. paštu ir slaptažodžiu** (registracija, slaptažodžio keitimas, atsijungimas).
- **Nuotraukos niekur neįkeliamos.** Visa analizė vyksta naršyklėje. Serveryje saugoma tik paskyra
  ir presetai, kuriuos patys išsaugote.
- **Apžvalga:** fotoaparatas (modelis, serijos nr., savininkas), objektyvas, ekspozicija (išlaikymas,
  diafragma, ISO, EV100, blykstė, matavimas…), data ir laikas su laiko juosta, GPS vieta su nuoroda į
  žemėlapį, vaizdo matmenys, spalvų profilis, histograma, raktažodžiai, autorių teisės, SHA-256.
- **Lightroom presetas:** visi nustatymai sugrupuoti kaip Lightroom „Create Preset“ lange, su
  vizualiais slankikliais, tonų kreive, HSL ir spalvų gradacija. Galite pasirinkti, kurias grupes
  įtraukti (apkarpymas, maskės, dėmių šalinimas pagal nutylėjimą neįtraukiami).
- **Atsisiuntimas:** `.xmp` presetas (Lightroom Classic 7.3+, Lightroom CC, Camera Raw) ir `.lrtemplate`
  (Lightroom 4–7.2). Kelių nuotraukų presetus galima atsisiųsti vienu `.zip`.
- **Identiškų presetų paieška:** jei kelios įkeltos nuotraukos apdorotos tuo pačiu presetu, jos
  pažymimos ta pačia žyma („Presetas A“).
- **Visa metadata:** kiekviena žyma su paieška, eksportas į JSON / CSV, neapdorotas XMP.
- **Mano presetai:** išsaugoti presetai jūsų paskyroje, kuriuos galima atsisiųsti bet kada.

## Kokius failus įkelti

| Failas | Ar yra preseto duomenų? |
| --- | --- |
| JPEG / TIFF, eksportuotas iš Lightroom su **Metadata: All Metadata** | Taip |
| DNG | Taip |
| RAW failo `.xmp` šalutinis failas | Taip |
| Nuotrauka iš Instagram / Facebook / Messenger | Ne, šios platformos metaduomenis ištrina |
| Eksportuota su „Copyright Only“ | Ne |

Jei nustatymų nerasta, programa paaiškina, kodėl, ir vis tiek parodo visą likusią metadata.

## Paleidimas

Reikia tik [Node.js](https://nodejs.org) 18.17 ar naujesnės versijos. Išorinių priklausomybių nėra.

```bash
npm start            # http://localhost:3000
npm test             # automatiniai testai
```

Aplinkos kintamieji:

| Kintamasis | Numatyta | Paskirtis |
| --- | --- | --- |
| `PORT` | `3000` | Prievadas |
| `HOST` | `0.0.0.0` | Adresas |
| `DATA_DIR` | `./data` | Kur saugomi vartotojai, sesijos ir presetai (JSON failai) |
| `ALLOW_REGISTRATION` | `true` | `false`: registruotis gali tik administratorius (žr. žemiau) |
| `COOKIE_SECURE` | automatiškai | `true`: slapukas siunčiamas tik per HTTPS |

Vartotoją galima sukurti iš komandinės eilutės, kai vieša registracija išjungta:

```bash
npm run create-user -- jusu@pastas.lt 'slaptazodis'
```

Viešame serveryje paleiskite programą už HTTPS (pvz., Caddy ar nginx). Per paprastą HTTP neveiks
SHA-256 skaičiavimas, o slaptažodžiai keliautų nešifruoti.

## Įkėlimas į Hostinger (FTP, PHP hostingas)

Bendrame Hostinger hostinge Node.js neveikia, todėl yra PHP versija (`php/`) su tomis pačiomis
funkcijomis. Įkėlimo paketą paruošia:

```bash
./scripts/build-hostinger.sh   # -> dist/lightroom-preset-decoder-hostinger.zip
```

Išarchyvuokite ir **visus** failus (kartu su paslėptu `.htaccess`) per FTP įkelkite tiesiai į
subdomeno aplanką. Išsamios instrukcijos yra faile `php/SVARBU-PERSKAITYK.txt`. Reikia PHP 8.0+.
Norėdami išjungti registraciją, nukopijuokite `config.sample.php` į `config.php`.

Vietinis PHP versijos bandymas: `cd dist/hostinger && php -S localhost:8080 ../../php/router-dev.php`

## Kaip importuoti presetą

- **Lightroom Classic:** Develop → „Presets“ skydelis → **+** → *Import Presets…*
- **Lightroom (CC):** Edit → Presets → **…** → *Import Presets…*
- **Lightroom Mobile:** importuokite kompiuteryje, presetas susisinchronizuos.
- **Lightroom 4–7.2:** naudokite `.lrtemplate` failą.

## Struktūra

```
server/          Node.js serveris (be priklausomybių): autentifikacija, presetų biblioteka
  server.js      maršrutai, statiniai failai, saugumo antraštės
  auth.js        scrypt slaptažodžiai, sesijos, bandymų ribojimas
  presets.js     vartotojo presetų saugykla
public/
  login.html, app.html
  js/metadata.js EXIF/IPTC/ICC/GPS (exifr) + histograma + SHA-256
  js/xmp.js      XMP paketų paieška (įskaitant JPEG Extended XMP) ir RDF analizė
  js/preset.js   preseto generavimas (.xmp ir .lrtemplate), grupės
  js/app.js      vartotojo sąsaja
  vendor/exifr   exifr 7.1.3 (MIT)
test/            node:test testai
```
