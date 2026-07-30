// ─────────────────────────────────────────────────────────────────────────────
//  In loving memory of Agha Mansoor (آقا منصور).
//
//  "...who taught me to stay curious and gave me the room to discover.
//   Every line of this exists because of you."
//
//  A quiet tribute, woven into SubVibe by his child. Find it by tapping the popup
//  logo three times, or by typing  subvibe.remember()  in the browser console.
//  The portrait below is ASCII, rendered from his restored photograph.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const PORTRAIT = [
    "0kMMNdx88o            Ol,coox8MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWMWW",
    "  :NxkOMOd               .llMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWMMWMNMMWMMMk",
    ",o0WNd:.lo               .cOMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMNMMMMWMWMMWMMNMWW",
    "kllc:                    .MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWMMMNWM8N8..MW0WNWxWN",
    "x                       .MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWMM8WNWNo  M0l0xox8",
    "                       ,WMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWWWOOdl0.kc   0lN",
    "        o             cWMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWNWNkoc0,c8 .  WN",
    "         :c          cMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWMWNN80           W",
    "           x        kMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWWWWWWWWWWMMMWMWMMWMWMMMMWMMWO0,",
    "          :d:     .8MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWWWWWWNWNWNNNNNNNNWWNNNNNNNNNNNNN8xc",
    "          :l: ..,d8MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWMNWNWNWNNNNNNNNNNNNNNNNN8N8NNN88N8N88N0xk",
    "              .cck8MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMNWNNWNNNNNNNNN8NNNN8N88888888N8888O8888O8Oxd,",
    ".          .::c:llMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWNWWNWNNN8N8NNNNO8N8N88N888N88888O8OOO8OOOOOOOxo.:,",
    "          .,,:,, lMMMMMMMMMMMMMMMMMMMMMMMMMMWMMWNNW8NNNWNNNNN8NNN8N88N8N8888888888O888OOOOOOOOOOO0O00xk:.:",
    "        .,,.,: . xWMMMMMMMMMMMMMMMMMMMMMWWW8NNWNNNWNNWNNNNNNNN8N888N8N888888888888O8OOOOOOO000O00O0000kko:,",
    "     ,l,     ,. c8MMMMMMMMMMMMMMMMMMMWWNNNOO8N8NN8NNN88NNN888N888N8N88888888O8O8OOO8OOOOOOO00O0000000xxolo:.",
    "    ,o          xkMMMMMMMMMMMMMMMMMMM8NN88NON88NNN8N8888N8NN888N88N8N8888888O88OOOOOOOOOO0O00000x0x0xxkkddo",
    "    :d         .:oMMMMMMMMMMMMMMMMWO8N888O8ONN888N8NNNNN8N8N8NN888N88N8888O8O8888OOO0OOO00000000x0x0xxxklooc",
    "                .8MMMMMMMMMMMMMMM8O888NO8888O888ON8ON8888NN8N88N8888N88888O888OOOO8OOO00O000000xx00xxxxkkdol.",
    "                 oWMMMMMMMMMMMMWNN8888888NN8NNMMMMMMMMMMMMWNN8N88N8N8ON88888O8O8OOOOO0O0x0000x0xxxx0xxxxkkkl:",
    "                 :WMMMMMMMMMMMWNNNNOO8WMMMMMMMMMMMMMMMMMMMMM8ON8888N8N88O88888O8OOOOO000000x000xx0xxxxxxxkkoc",
    "                  WMMMMMMMMMMM8NO888NWMMMMMMMMMMMMMMMMMMMMMMMMMNN88888888O888OOOOOO0O00O00x0xxxxxxx0xxxxxxkdl:",
    "                  NMMMMMMMMWN8O8O00xNMMMMMMMMMMMMMMMMMMMMMMMMMMM8888888OOOOOOO00O0xkodloookxkxxxxxxxxxxxxkxkd.",
    "                  8MMMMMMWNWNO8OOOWMMMMMMMMMMMMMMMMMMWWWNW8NNNNN88N88OO00xxdkcll. .,, ,     .  ldkkdxxkxxxkkko",
    "      ,:.         cMMMMMMWWNWNMMMMMMMMMMMMMMMMMMMWN8NWN8O88N88O88O80kkdold                        :kxxxxxxxkdo",
    "   l08NNNx         MMMMMMWWWMWMMMMMMMMMMMMMWN88NN88O8O8OO8x0OO00xkxoc  .                             kkxkkkxkko",
    " o8NN8888Nx        NMMMMMMMMMMMMMMMMMMMMWNO88O8OOO08OOOO00Oxkxkcol                    .:clcl:ll,      lkkxkkkdd:",
    ",8NNN8N888Nkc       NNWMMMMMMMMMMMMMMMMNO88O000000x0O00000xkdlc: , .             . ,:cllodokdkddloolcclldkkkkddo:",
    "OWNNNWN888N80l      k8NMMMMMMMMMMMMMMMNNOkkkkoxdkoxdkx00xxkxd:l,.,c ...    ..             .codddkooddoodddkkddddo",
    "NWN8000O8N880l       8WMMMMMMMMMMMMW0O8xcx :     :,:ldxkkkkdoolllollool:                  .   ,oddddkdddddddkdkkdo",
    "WMN80O0ON8NOx,       .NMMMMMMMWN08N0o8c. .           coododdokddddddo:.                       . .clldddokdkkkkkddd:",
    "NMW8O0OO8O0d.         MMMMMM808M8080...               llolookkkkdkdl,         .              ..,c.ccloddkdkdkkdkkdd",
    " oMWN88Okl.           8MM8okdklox  .                   coodkkkkxkoo.                ,cl::lc:lcllllllooddddkokkkdddo",
    "  xM0c      o         .MMcolc:c,,c:,,.                 .od000xxdddc.             .:lloooooollollclloddododkdkkkkkdd",
    "  co                   MMdd,cc::c,                      dk00x00xdooc,         ..::lcllllolloccolldodddddddkddkkdkkd",
    "                       MMWlcccl:                        o0O8O00kkdollc:c..     .,:cclccl:l:clcccoodddddddddkkkkkkkd",
    " x                     MMMkcco:                        ,oO0O0O0Oxxkddodooololc,,,:c:,c:cclooooodkkdkdkdkkdkdxkkkkkk",
    " ,                     NMM0ll,                        ::oOO8OOk0xkxxkkddddkkdkddodoolooddokddxdkkkkdkkxkkkkxkxxkkdk",
    "                       lMMx:.       .               .:lldxO88OO0x0xxxxxxxxxkxxxxxxxkkkkdkxxxxdkdxkkkxooxxxxxxxdxkko",
    "                 .      MMWc    ..., .           .,::llokO0NN880O00xx0000xx0xkxxxxxxxxxxkkxxxxkxkxxkkxkkxxx0xxxxkkd",
    "   .                    MMMN.::,..             :c:cccdlkxx8MMMOO0000xxxx0000x000kxx0x0xOkxx0xxxxxkxxxxxxxxxxxkxkxkx",
    "  d88l                  MMMMOcl:c:,:,:...,.,:lloc:lllo:kOOMMMMMMOOO00xxkkddxx00x0000k000x00x0xxxxxxdkxxxxxxxxxxxxxk",
    "MMMMMMMMMMMMN,          OMMMNkooddollclcccllooololllcc:kMMMMMMMM8O800kkxkdoldkxx000000O0O0000xxxxxxkkxxx0xxxx0xkkkk",
    "MMMMMMMMMMMMM:           MMMMMWoddodoodooooddooooll:..:MMMMMMWWN8OOOxxxxkkxolldkxxx0x0O00OOO000xxxkxxxxxxxxxxxxxkkk",
    "MMMMMMMMMMMMO            MMMMMMOdkkdkkkdkddkdododc:,  MMMMWNOOOO00O0O000O0xkldldkkxkx0O0O0000000kkxkxxxxkkkdxxxxkkd",
    "MMMMMMMMMMMMMo       d   MMMMMMdkkkkxxkkdkkddooolc: :OO0xkxxkx0000O00000Ox0xkloodddkxxx0x0OO00x0xxx0xokxxxxxkkxkddk",
    "MMMMMMMMMMMMMk, c0xlcO., MMMMM88O8k0xkkkkkkddddll:. 0dodddddkkkxx0kxxxO0xxxxdldkdooddxk0x0000000xxxxxxkkxxkxkkxdkdd",
    "WMMMMMMMMMMMM80O800xxx:, MMMNWNWMMW0kxkkkkddddoll:,ckdolooolloddkdd     ,cll,oddddddokkxx0xx0xxxx0xxkxkxxkkkkxdddkd",
    ":0WMMMMWWWMMMW88N88Oo. . MMN88NMMMMkkkxkxkdkddool:, l:     lccccl ,        .llddkddolooddkxkxkxxxxxkdxxxkkkokkdkkdk",
    " k8MMMWWWWMWMN88N88O:    WMW008MMMMkdkkdkkkddoolc,,..                        ,.ollddoolccolkkxkxkkxkkkxkkkkkddkookd",
    "   NMMMNWNNNWk  kN8x      WW8O0WMM8Olokdkdooodl::,:,..                           ,.   .,:,:lokkkxxxxkkxoxkkdkkdkokk",
    "   ,MMMxldNNWk   cNx      N88088888odddddddoooc::,,:,                                 .    ::ldkkkxkkkdkokdkddodkkd",
    "    :8x   .x8l    d8.      OOOOx000lolooooool::,:,,.                                         :ldkdkdkkkkodkkdkddkdd",
    "                   l       dO00k0xoddoodollc: ... .                                           lokkkdkdkdddlddddokok",
    "     ,                      x0xkdkoodooollc:                                                   codddkkdddododoolddd",
    "   dWMMMMc                   xkkkdddolllcl.                                                     doddoodd:dddodooodo",
    ".xMMMMMMMMM                   xkdddoooolcc                                                     ,oddoloodooddddoddod",
    "MMMMMMMMMMMc                  :kdkddllolc.                          .                          .ldoddoodooolldooddo",
    "MMMMMMMM8:                     lkddoooolc                                                       ldoodoodoldoloodloo",
    "                                odddooll:                                      .,::c,..        cloollolloollooooooo",
    "                                 koddollc,                               .,,cloooll:c::,.,..,, ,coooolooolololooolo",
    ".                                 ddooollc                           .,:lodoodlollclcc:::::::.::lclcllllolooolllldo",
    ".,.:l,:clccc                       ddololc.               .     :c:colcololoooloclllcccccc:c::::ccccclllllllclololl",
    "dlloxkdxkxxc                      ,M:lllcl:.,             ,:ccc:,c:.:.,,:,:,lllllollccccccc::::::ccccllclllcollll:,",
    "O0x0kMNO0Oxd:                    lWWWxlllcl:, .           ,.,,::..:.  .,,,:cccllcclclcccc:::::.::ccc:ccclllcllll.,:",
    "W888xkMMMMMMx0k,                 xMMMMM,lccc,.. ..       . ...  . .,. .,. . .,,::ccclccc:c:::.c:::ccc,::cccclll .:c",
    "WO88xkxMMMMMMM0xOd            ,WMMMMMMM0occcc:,..         . .....,.      ... ,::c::c:::c:c: ::::::::::c:clclc: .:::",
    "0OMOkkxMMMMMWWMN0xO:       OMMMMMMMMMMM  dllllc, .        .. .. .... ..   . .,,::::c::cc::::,:c,:,,,c:c:cccc, ::::c",
    "0WNxO8NMMMMMMO0MWWO8Wc kMMMMMMMMMMMMMMM   llll::,..         .   .   .  .....,::::::c:c,ccc:::::,:,:c::c:c:c ,::::::",
    "0MO08MMW0d8MM880WMM8MMMMMMMMMMMMMMMMMMN    ,cccc:.....  . .  ...  . ....,,,,::::,:c:cc::c:::.:::,,,,:c:::, .,,:::::",
    "NMWWMMMMW.l808OO88MMMMMMMMMMMMMMMMMMMM.      .c::::...... . .  . .. ..,,,,.,::::c:c::::,.:::.,:,,:,:::::,,,,,:,::::",
    "MMNWMMMMM cxdklN888MMMMMMMMMMMMMMMMMMM          c:,:.,.,..,. .. , ,,,,.:, :c:c,,c:c::cc,c::::,:,,:::,:,,,,:,:,:,:,:",
    "MNNOMMMNOl.odcok8x80MMMMMMMMMMMMMMMMMM            .,,,,,:.,.,.,.,.,,,:.:ccc:cc:lcclcccc::cc:.  ,:,,,,,,,,:,,:,,:,,:",
    "8NN8WNN8Oc:coolok8xk8NNMMMMMMMMMMMMMMl               ,.,,:,.,:,::.c::c::cccccclc:l::c:c:,:,..:,,,,,.,,,,,,,,,,,:,,,",
    "NN88NNN80.ccocoddokdlkkdNMMMMMMMMMMMM                   ,::cl:cc:lclccc:ccc:c::::,,,.,. ..,,,,,,.,,,,,,,,,,,,:,,,,:",
    "888088880 .:oodddddollllcxMMMMMMMMMMM                     :::::::c:ccccll:c.,,,        .,,,,,,,,,,,,,,,,,,,,,,,,,,.",
    "88O8OO80xl,ddkdddddoollc,cMMMMMMMMMMW:                     ..,,. ,,. .         .  . . .,.,,,,,,,,.,,,,,,,,,,,,,,,.,"
  ].join("\n");
  const NAME = "Agha Mansoor";
  const DEDICATION = "In loving memory of my father, Agha Mansoor — who taught me to stay curious and gave me the room to discover. Every line of this exists because of you.";

  const g = (typeof window !== "undefined") ? window : (typeof globalThis !== "undefined" ? globalThis : this);
  try { g.SV_TRIBUTE = { portrait: PORTRAIT, name: NAME, dedication: DEDICATION }; } catch (e) {}

  // Console easter egg — type  subvibe.remember()  anywhere SubVibe runs.
  try {
    g.subvibe = g.subvibe || {};
    g.subvibe.remember = function () {
      console.log("%c" + PORTRAIT, "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9px;line-height:1.05;color:#b8c9e6;");
      console.log("%c♥  " + DEDICATION, "color:#7fe0b0;font-size:12.5px;font-weight:600;");
      return "In memory of " + NAME;
    };
    if (!g.__svRememberHinted) {
      g.__svRememberHinted = true;
      console.log("%cSubVibe — in memory of Agha Mansoor ♥   ·   type subvibe.remember()", "color:#8b95a6;font-style:italic;");
    }
  } catch (e) {}
})();
