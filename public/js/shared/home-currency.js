// A home currency, guessed from the phone: what "Make a trip" offers a person whose account has
// none yet (public/js/trips.js). It is a guess, and the page says so beside it.
//
// The phone's region comes from its language tag (navigator.languages: "en-NL" is English, in
// the Netherlands); a tag with no region ("nl") falls back to the country of the phone's time
// zone. A region gives its currency. No region, or one whose money the app doesn't know, is no
// guess at all.
//
// The two tables are data, generated, not typed: each region's current legal tender from the
// Unicode CLDR (v48.2, supplemental/currencyData.json; Unicode License v3), kept to the codes
// public/js/money.js knows, and each time zone's country from the IANA time zone database
// (2025b, zone.tab; public domain). check:trips (its part "guess") holds the guess and the
// tables; check:trips-browser holds what Your trips shows.

// "ADEUR" is Andorra, the euro.
const REGIONS = [
  "ACSHP ADEUR AEAED AFAFN AGXCD AIXCD ALALL AMAMD AOAOA ARARS ASUSD ATEUR AUAUD AWAWG AXEUR AZAZN",
  "BABAM BBBBD BDBDT BEEUR BFXOF BGEUR BHBHD BIBIF BJXOF BLEUR BMBMD BNBND BOBOB BQUSD BRBRL BSBSD",
  "BTBTN BVNOK BWBWP BYBYN BZBZD CACAD CCAUD CDCDF CFXAF CGXAF CHCHF CIXOF CKNZD CLCLP CMXAF CNCNY",
  "COCOP CRCRC CUCUP CVCVE CXAUD CYEUR CZCZK DEEUR DGUSD DJDJF DKDKK DMXCD DODOP DZDZD EAEUR ECUSD",
  "EEEUR EGEGP EHMAD ERERN ESEUR ETETB EUEUR FIEUR FJFJD FKFKP FMUSD FODKK FREUR GAXAF GBGBP GDXCD",
  "GEGEL GFEUR GGGBP GHGHS GIGIP GLDKK GMGMD GNGNF GPEUR GQXAF GREUR GSGBP GTGTQ GUUSD GWXOF GYGYD",
  "HKHKD HMAUD HNHNL HREUR HTUSD HUHUF ICEUR IDIDR IEEUR ILILS IMGBP ININR IOUSD IQIQD IRIRR ISISK",
  "ITEUR JEGBP JMJMD JOJOD JPJPY KEKES KGKGS KHKHR KIAUD KMKMF KNXCD KPKPW KRKRW KWKWD KYKYD KZKZT",
  "LALAK LBLBP LCXCD LICHF LKLKR LRLRD LSLSL LTEUR LUEUR LVEUR LYLYD MAMAD MCEUR MDMDL MEEUR MFEUR",
  "MGMGA MHUSD MKMKD MLXOF MMMMK MNMNT MOMOP MPUSD MQEUR MRMRU MSXCD MTEUR MUMUR MVMVR MWMWK MXMXN",
  "MYMYR MZMZN NANAD NCXPF NEXOF NFAUD NGNGN NINIO NLEUR NONOK NPNPR NRAUD NUNZD NZNZD OMOMR PAUSD",
  "PEPEN PFXPF PGPGK PHPHP PKPKR PLPLN PMEUR PNNZD PRUSD PSJOD PTEUR PWUSD PYPYG QAQAR REEUR RORON",
  "RSRSD RURUB RWRWF SASAR SBSBD SCSCR SDSDG SESEK SGSGD SHSHP SIEUR SJNOK SKEUR SLSLE SMEUR SNXOF",
  "SOSOS SRSRD SSSSP STSTN SVUSD SYSYP SZSZL TAGBP TCUSD TDXAF TFEUR TGXOF THTHB TJTJS TKNZD TLUSD",
  "TMTMT TNTND TOTOP TRTRY TTTTD TVAUD TWTWD TZTZS UAUAH UGUGX UMUSD USUSD UYUYU UZUZS VAEUR VCXCD",
  "VEVES VGUSD VIUSD VNVND VUVUV WFXPF WSWST XKEUR YEYER YTEUR ZAZAR ZMZMW ZWZWG",
].join(" ");

// "Europe/Amsterdam=NL".
const ZONES = [
  "Africa/Abidjan=CI Africa/Accra=GH Africa/Addis_Ababa=ET Africa/Algiers=DZ Africa/Asmara=ER Africa/Bamako=ML",
  "Africa/Bangui=CF Africa/Banjul=GM Africa/Bissau=GW Africa/Blantyre=MW Africa/Brazzaville=CG Africa/Bujumbura=BI",
  "Africa/Cairo=EG Africa/Casablanca=MA Africa/Ceuta=ES Africa/Conakry=GN Africa/Dakar=SN Africa/Dar_es_Salaam=TZ",
  "Africa/Djibouti=DJ Africa/Douala=CM Africa/El_Aaiun=EH Africa/Freetown=SL Africa/Gaborone=BW Africa/Harare=ZW",
  "Africa/Johannesburg=ZA Africa/Juba=SS Africa/Kampala=UG Africa/Khartoum=SD Africa/Kigali=RW Africa/Kinshasa=CD",
  "Africa/Lagos=NG Africa/Libreville=GA Africa/Lome=TG Africa/Luanda=AO Africa/Lubumbashi=CD Africa/Lusaka=ZM",
  "Africa/Malabo=GQ Africa/Maputo=MZ Africa/Maseru=LS Africa/Mbabane=SZ Africa/Mogadishu=SO Africa/Monrovia=LR",
  "Africa/Nairobi=KE Africa/Ndjamena=TD Africa/Niamey=NE Africa/Nouakchott=MR Africa/Ouagadougou=BF Africa/Porto-Novo=BJ",
  "Africa/Sao_Tome=ST Africa/Tripoli=LY Africa/Tunis=TN Africa/Windhoek=NA America/Adak=US America/Anchorage=US",
  "America/Anguilla=AI America/Antigua=AG America/Araguaina=BR America/Argentina/Buenos_Aires=AR America/Argentina/Catamarca=AR America/Argentina/Cordoba=AR",
  "America/Argentina/Jujuy=AR America/Argentina/La_Rioja=AR America/Argentina/Mendoza=AR America/Argentina/Rio_Gallegos=AR America/Argentina/Salta=AR America/Argentina/San_Juan=AR",
  "America/Argentina/San_Luis=AR America/Argentina/Tucuman=AR America/Argentina/Ushuaia=AR America/Aruba=AW America/Asuncion=PY America/Atikokan=CA",
  "America/Bahia=BR America/Bahia_Banderas=MX America/Barbados=BB America/Belem=BR America/Belize=BZ America/Blanc-Sablon=CA",
  "America/Boa_Vista=BR America/Bogota=CO America/Boise=US America/Cambridge_Bay=CA America/Campo_Grande=BR America/Cancun=MX",
  "America/Caracas=VE America/Cayenne=GF America/Cayman=KY America/Chicago=US America/Chihuahua=MX America/Ciudad_Juarez=MX",
  "America/Costa_Rica=CR America/Coyhaique=CL America/Creston=CA America/Cuiaba=BR America/Curacao=CW America/Danmarkshavn=GL",
  "America/Dawson=CA America/Dawson_Creek=CA America/Denver=US America/Detroit=US America/Dominica=DM America/Edmonton=CA",
  "America/Eirunepe=BR America/El_Salvador=SV America/Fort_Nelson=CA America/Fortaleza=BR America/Glace_Bay=CA America/Goose_Bay=CA",
  "America/Grand_Turk=TC America/Grenada=GD America/Guadeloupe=GP America/Guatemala=GT America/Guayaquil=EC America/Guyana=GY",
  "America/Halifax=CA America/Havana=CU America/Hermosillo=MX America/Indiana/Indianapolis=US America/Indiana/Knox=US America/Indiana/Marengo=US",
  "America/Indiana/Petersburg=US America/Indiana/Tell_City=US America/Indiana/Vevay=US America/Indiana/Vincennes=US America/Indiana/Winamac=US America/Inuvik=CA",
  "America/Iqaluit=CA America/Jamaica=JM America/Juneau=US America/Kentucky/Louisville=US America/Kentucky/Monticello=US America/Kralendijk=BQ",
  "America/La_Paz=BO America/Lima=PE America/Los_Angeles=US America/Lower_Princes=SX America/Maceio=BR America/Managua=NI",
  "America/Manaus=BR America/Marigot=MF America/Martinique=MQ America/Matamoros=MX America/Mazatlan=MX America/Menominee=US",
  "America/Merida=MX America/Metlakatla=US America/Mexico_City=MX America/Miquelon=PM America/Moncton=CA America/Monterrey=MX",
  "America/Montevideo=UY America/Montserrat=MS America/Nassau=BS America/New_York=US America/Nome=US America/Noronha=BR",
  "America/North_Dakota/Beulah=US America/North_Dakota/Center=US America/North_Dakota/New_Salem=US America/Nuuk=GL America/Ojinaga=MX America/Panama=PA",
  "America/Paramaribo=SR America/Phoenix=US America/Port-au-Prince=HT America/Port_of_Spain=TT America/Porto_Velho=BR America/Puerto_Rico=PR",
  "America/Punta_Arenas=CL America/Rankin_Inlet=CA America/Recife=BR America/Regina=CA America/Resolute=CA America/Rio_Branco=BR",
  "America/Santarem=BR America/Santiago=CL America/Santo_Domingo=DO America/Sao_Paulo=BR America/Scoresbysund=GL America/Sitka=US",
  "America/St_Barthelemy=BL America/St_Johns=CA America/St_Kitts=KN America/St_Lucia=LC America/St_Thomas=VI America/St_Vincent=VC",
  "America/Swift_Current=CA America/Tegucigalpa=HN America/Thule=GL America/Tijuana=MX America/Toronto=CA America/Tortola=VG",
  "America/Vancouver=CA America/Whitehorse=CA America/Winnipeg=CA America/Yakutat=US Antarctica/Casey=AQ Antarctica/Davis=AQ",
  "Antarctica/DumontDUrville=AQ Antarctica/Macquarie=AU Antarctica/Mawson=AQ Antarctica/McMurdo=AQ Antarctica/Palmer=AQ Antarctica/Rothera=AQ",
  "Antarctica/Syowa=AQ Antarctica/Troll=AQ Antarctica/Vostok=AQ Arctic/Longyearbyen=SJ Asia/Aden=YE Asia/Almaty=KZ",
  "Asia/Amman=JO Asia/Anadyr=RU Asia/Aqtau=KZ Asia/Aqtobe=KZ Asia/Ashgabat=TM Asia/Atyrau=KZ",
  "Asia/Baghdad=IQ Asia/Bahrain=BH Asia/Baku=AZ Asia/Bangkok=TH Asia/Barnaul=RU Asia/Beirut=LB",
  "Asia/Bishkek=KG Asia/Brunei=BN Asia/Chita=RU Asia/Colombo=LK Asia/Damascus=SY Asia/Dhaka=BD",
  "Asia/Dili=TL Asia/Dubai=AE Asia/Dushanbe=TJ Asia/Famagusta=CY Asia/Gaza=PS Asia/Hebron=PS",
  "Asia/Ho_Chi_Minh=VN Asia/Hong_Kong=HK Asia/Hovd=MN Asia/Irkutsk=RU Asia/Jakarta=ID Asia/Jayapura=ID",
  "Asia/Jerusalem=IL Asia/Kabul=AF Asia/Kamchatka=RU Asia/Karachi=PK Asia/Kathmandu=NP Asia/Khandyga=RU",
  "Asia/Kolkata=IN Asia/Krasnoyarsk=RU Asia/Kuala_Lumpur=MY Asia/Kuching=MY Asia/Kuwait=KW Asia/Macau=MO",
  "Asia/Magadan=RU Asia/Makassar=ID Asia/Manila=PH Asia/Muscat=OM Asia/Nicosia=CY Asia/Novokuznetsk=RU",
  "Asia/Novosibirsk=RU Asia/Omsk=RU Asia/Oral=KZ Asia/Phnom_Penh=KH Asia/Pontianak=ID Asia/Pyongyang=KP",
  "Asia/Qatar=QA Asia/Qostanay=KZ Asia/Qyzylorda=KZ Asia/Riyadh=SA Asia/Sakhalin=RU Asia/Samarkand=UZ",
  "Asia/Seoul=KR Asia/Shanghai=CN Asia/Singapore=SG Asia/Srednekolymsk=RU Asia/Taipei=TW Asia/Tashkent=UZ",
  "Asia/Tbilisi=GE Asia/Tehran=IR Asia/Thimphu=BT Asia/Tokyo=JP Asia/Tomsk=RU Asia/Ulaanbaatar=MN",
  "Asia/Urumqi=CN Asia/Ust-Nera=RU Asia/Vientiane=LA Asia/Vladivostok=RU Asia/Yakutsk=RU Asia/Yangon=MM",
  "Asia/Yekaterinburg=RU Asia/Yerevan=AM Atlantic/Azores=PT Atlantic/Bermuda=BM Atlantic/Canary=ES Atlantic/Cape_Verde=CV",
  "Atlantic/Faroe=FO Atlantic/Madeira=PT Atlantic/Reykjavik=IS Atlantic/South_Georgia=GS Atlantic/St_Helena=SH Atlantic/Stanley=FK",
  "Australia/Adelaide=AU Australia/Brisbane=AU Australia/Broken_Hill=AU Australia/Darwin=AU Australia/Eucla=AU Australia/Hobart=AU",
  "Australia/Lindeman=AU Australia/Lord_Howe=AU Australia/Melbourne=AU Australia/Perth=AU Australia/Sydney=AU Europe/Amsterdam=NL",
  "Europe/Andorra=AD Europe/Astrakhan=RU Europe/Athens=GR Europe/Belgrade=RS Europe/Berlin=DE Europe/Bratislava=SK",
  "Europe/Brussels=BE Europe/Bucharest=RO Europe/Budapest=HU Europe/Busingen=DE Europe/Chisinau=MD Europe/Copenhagen=DK",
  "Europe/Dublin=IE Europe/Gibraltar=GI Europe/Guernsey=GG Europe/Helsinki=FI Europe/Isle_of_Man=IM Europe/Istanbul=TR",
  "Europe/Jersey=JE Europe/Kaliningrad=RU Europe/Kirov=RU Europe/Kyiv=UA Europe/Lisbon=PT Europe/Ljubljana=SI",
  "Europe/London=GB Europe/Luxembourg=LU Europe/Madrid=ES Europe/Malta=MT Europe/Mariehamn=AX Europe/Minsk=BY",
  "Europe/Monaco=MC Europe/Moscow=RU Europe/Oslo=NO Europe/Paris=FR Europe/Podgorica=ME Europe/Prague=CZ",
  "Europe/Riga=LV Europe/Rome=IT Europe/Samara=RU Europe/San_Marino=SM Europe/Sarajevo=BA Europe/Saratov=RU",
  "Europe/Simferopol=UA Europe/Skopje=MK Europe/Sofia=BG Europe/Stockholm=SE Europe/Tallinn=EE Europe/Tirane=AL",
  "Europe/Ulyanovsk=RU Europe/Vaduz=LI Europe/Vatican=VA Europe/Vienna=AT Europe/Vilnius=LT Europe/Volgograd=RU",
  "Europe/Warsaw=PL Europe/Zagreb=HR Europe/Zurich=CH Indian/Antananarivo=MG Indian/Chagos=IO Indian/Christmas=CX",
  "Indian/Cocos=CC Indian/Comoro=KM Indian/Kerguelen=TF Indian/Mahe=SC Indian/Maldives=MV Indian/Mauritius=MU",
  "Indian/Mayotte=YT Indian/Reunion=RE Pacific/Apia=WS Pacific/Auckland=NZ Pacific/Bougainville=PG Pacific/Chatham=NZ",
  "Pacific/Chuuk=FM Pacific/Easter=CL Pacific/Efate=VU Pacific/Fakaofo=TK Pacific/Fiji=FJ Pacific/Funafuti=TV",
  "Pacific/Galapagos=EC Pacific/Gambier=PF Pacific/Guadalcanal=SB Pacific/Guam=GU Pacific/Honolulu=US Pacific/Kanton=KI",
  "Pacific/Kiritimati=KI Pacific/Kosrae=FM Pacific/Kwajalein=MH Pacific/Majuro=MH Pacific/Marquesas=PF Pacific/Midway=UM",
  "Pacific/Nauru=NR Pacific/Niue=NU Pacific/Norfolk=NF Pacific/Noumea=NC Pacific/Pago_Pago=AS Pacific/Palau=PW",
  "Pacific/Pitcairn=PN Pacific/Pohnpei=FM Pacific/Port_Moresby=PG Pacific/Rarotonga=CK Pacific/Saipan=MP Pacific/Tahiti=PF",
  "Pacific/Tarawa=KI Pacific/Tongatapu=TO Pacific/Wake=UM Pacific/Wallis=WF",
].join(" ");

let regions = null;
let zones = null;
const regionTable = () => regions ??= new Map(REGIONS.split(" ").map((s) => [s.slice(0, 2), s.slice(2)]));
const zoneTable = () => zones ??= new Map(ZONES.split(" ").map((s) => s.split("=")));

/** The region a language tag names, or "" ("en-GB" → "GB", "zh-Hant-TW" → "TW", "nl" → "", "es-419" → ""). */
export function regionOf(tag) {
  // A country's two letters only: "es-419" names Latin America (UN M.49), which has no one currency.
  try { const r = new Intl.Locale(String(tag)).region || ""; return /^[A-Z]{2}$/.test(r) ? r : ""; } catch { return ""; }
}

/** The currency a region uses today, or "" when there's none the app knows. */
export const currencyOfRegion = (region) => regionTable().get(String(region).toUpperCase()) || "";

/** Every region the table knows. */
export const knownRegions = () => [...regionTable().keys()];

/** The country a time zone is in, or "". */
export const regionOfZone = (zone) => zoneTable().get(String(zone)) || "";

/**
 * The guess: { code, region, from } with `from` "language" or "zone", or null. Reads the
 * phone's own language list and time zone unless given (the check gives them).
 */
export function guessHomeCurrency({ languages = globalThis.navigator?.languages ?? [globalThis.navigator?.language], timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const tag = (languages || []).find(Boolean);
  const fromTag = tag ? regionOf(tag) : "";
  const region = fromTag || regionOfZone(timeZone);
  const code = region ? currencyOfRegion(region) : "";
  return code ? { code, region, from: fromTag ? "language" : "zone" } : null;
}
