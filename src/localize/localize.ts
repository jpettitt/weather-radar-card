import * as en from "./languages/en.json";
import * as nb from "./languages/nb.json";
import * as sk from "./languages/sk.json";
import * as fr from "./languages/fr.json";
import * as de from "./languages/de.json";
import * as nl from "./languages/nl.json";
import * as es from "./languages/es.json";
import * as it from "./languages/it.json";
import * as pl from "./languages/pl.json";
import * as sr from "./languages/sr.json";
import * as sr_Latn from "./languages/sr-Latn.json";
import * as sv from "./languages/sv.json";
import * as pt_BR from "./languages/pt_BR.json";

const languages: any = {
  en: en,
  nb: nb,
  sk: sk,
  fr: fr,
  de: de,
  nl: nl,
  es: es,
  it: it,
  pl: pl,
  sr: sr,
  sr_Latn: sr_Latn,
  sv: sv,
  pt_BR: pt_BR,
};

export function localize(string: string, search: string = "", replace = "") {
  const lang = (localStorage.getItem("selectedLanguage") || "en")
    .replace(/['"]+/g, "")
    .replace("-", "_");

  let translated: string;

  try {
    translated = string.split(".").reduce((o, i) => o[i], languages[lang]);
  } catch (e) {
    translated = string.split(".").reduce((o, i) => o[i], languages["en"]);
  }

  if (translated === undefined)
    translated = string.split(".").reduce((o, i) => o[i], languages["en"]);

  if (search !== "" && replace !== "") {
    translated = translated.replace(search, replace);
  }
  return translated;
}
