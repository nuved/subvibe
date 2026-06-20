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
    "kNMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWNNN8OO0xoc::. :c ,.,:l:c,:,",
    "WMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWWWMWMWMMMMMMMMWWNN88O0kdc,,. ..   .lk,.,,,,.",
    "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWW8O88O8888N88NNNNNN8NN88N8OOxkl:         .c,....,:.",
    "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMWN88OOOOOOOOOOO8O8OOOO8O8OOO888000xdc. .   .       .  ..",
    "MMMMMMMMMMMMMMMMMMMMMMWMMMMMMMMMMW8OOO8OOOOOOOOOOOO000000OO0O000000000O0Oxdl,",
    "MMMMMMMMMMMMMMMMMMMMWMMMMMMMWMWWW8OOOOOOO0OOO0O00000O0O00000000000000x0x0xdl:.",
    "MMMMMMMMMMMMMMMMMMWNNWWWNN88888000OOOO000000000000000000000xxxxxxxxxxxxxxkkl: .",
    "MMMMMMMMMMMMMMWNN88OOOOO0O000OO00O0O0000000000000x000x0xxxx0xxxxxkxkxkkkkkko:.,..",
    "MMMMMMMMMMMWW8OOO00x000000OO000O00000O00x0000xx0xxxx0xxxxxxxxxkxkkkkkkkkkkkol:.,.",
    "MMMMMMMMMWW8O0000xkxx000x00000x000000000000x0x0x0xxxxxxxxxxkxkxkkkkkkkkkkdddo:c:.",
    "MMMMMWOO88OO000xkkxxx0000x0x000000000x0x0x00xx00x0xxxxxxxkxkxkxkkkkkkdkdkdddolcc,",
    "MMMMNO888Oxxxkxxxxxx0xxxxxx00x0000000x0x000x00xxxkxxxxxxkxkkkkkkkkkdkdkdkdddoo:c:,",
    "MMMWWWW80xkxxxxxxxxkxxxxx000x00xxxx0000x00xxxx0x0x0xxxxkxxxkkkkkkkkdkddddkddoool:,",
    "MMMMW8O0000xxxk08NWWNNNN8WMMMMMMMWx0x000x00000xxx0x0xxxxxkkxkkkdkdkdkddkdddddodol,",
    "MMWN8Ox0xxkkxxWMMMMMWMMMMMMMMMMMWN8OOxxx00x0x0xxxxxxkxkxkxkkkkkdkddddddddddddddolc,               ,odl,",
    "MWNOOxkxkddokOO8WMMMMMMMMMMWWWWWN8NN8OOkxxx0xxxxkxxkkkkddollcclllododddddddddddool,             .,lcloo.",
    "W000xxkdddxOWMMMMMMMMMMMMWWN0O0xx0O00xxxx0xxkkddllcc::,.......  . ...:coooododddooc.            .:clollc.",
    "000xxx8NWMMMMMMMMMWNN8OO00xx00xxxxxxxkxxkkolcc:,..         .           .,loododoool:            ,cldoool,",
    "880O00NMMMMMMMMMN000xxxx0xkxxkkkkddddoool:,.                 . . ..       .cododoooc,          .,coooolcl.",
    "NWWWWMMMMMMMMMWxxxkkkkkkkkkkkkkdddolcc,,,.               ...,:ccccccc:,,...,cooooool:.         :llddooc:l:",
    "NWMMMMMMMMMMMN0kdoooooooooodddoddooc,,,...       .....,,,.,,,,,:cllllllllcccclooooollc.       .clddkdoc:c:.",
    "WMMMMMMMMWW0dol:.,,....,,,:clooooolcc:::::::::,..            ..   .,clolololollloolool:.       ,cddkkddccc:",
    "MMMMMW8xoloc,::..        . .,lllllllcllcllcc:.                    . ..:ccllllloloooolll.       .:cloloodclc.",
    "MMW8klodocl:.             . .,cccccllolllc:.        .          . . ..,,,::cllooolooloolc.      .:ccccccolll,",
    "Mk:,::,.,.... .               ,cclloooooc:.              ..,,:::::c:cc:ccccllllollooolll.       ,l:cccc:oll:",
    "Nc,,:,,,,,,..                 .:ldddoollc:. .     .  ..,,ccccclccccccccccllllllollooooll:       .cc::::coolc",
    "Ml:.,,::,                      :odkdkdlocc:,.. .   ..,,:,:::cccc:c:c::clllllllloooloooolc.      .::,,cldlll:",
    "MOc,,::.                      .:odkkddooolccc:::,,....,,,:,:,,,:,cccclllclllolollloooolll:,.. . .: ,oddoooo,",
    "MWd.,,                       .,:okkdddoooooocllllllllc::::cccccclclllololooooooloooooooool::::c:::clddkdddd,",
    "MWd,..    . .... ...      ..,::codkxkkdddododoooooodoooolollloooooooolooooolldodddooooollllllcllllloddkdkkl",
    "MMx,  ...,.,...... . .  ..,,:cclddkxxkkdddoddddddddoodddododoooooodooodooooooodddoddooololllcllolllooddddo:",
    "OWWx..,,..........   .,::::cccloodNO0kkdkkddddddddddddldddoddoloddooddoododdddooddodooooolcllollllclodddd:",
    "kWMNd,,,:,:,,,,,,,,,cc:c::ccc:cokWMMMWOdkkddoollclloddddddodkkdkdddddoddoloddddodddooooololllllolccodddo,",
    "lNWNkc:cclccccc:ccccccccccc:,.cOMMMMW8Okkkkdooollccclodddkdkddkdkkdddddodddododdddddodoolllllllllc:....",
    ":8MWNN0llllolllllllllcllc:,..,NWMN8xkkkkxkddddddolccclloddddkkkkkkkkddooooododooooddoololllcllllc::kkdooolldxxkc",
    ".8MWWWNoclllooocclollllcc,,.:dkooodkkkkkkkkkddkdkdlcccllooodddkdkkdkdddddoolododdoooollolollllclcloWMMMMMMMMMW8Oo",
    ".0WWN8dolcoodooooolollcc:,,cllllololooodddoddddddol:cllcllloddddkkkddddddododododooollllllllllllcloNMMMMMMMMMMW8O",
    ".0W8xxxx88dllooooollllcc:,,lccccclccllollc,   ..:c,:llllllllloddddddodddoooooooooooololclllclllllclNMMMMMMMMMMMMW",
    ".kN0ddxOWW0olloooloolccc:,.,:.  ..:::::c..   . .  ,:lloollcclllooooloddodloddooolollllllllllllllllcNMMMMMMMMMMMMW",
    " l00ddk8WWOccoololllllc:,,,,.        .             ..,,:::c::::cclodooodooooooooooloccllllllllllccoNMMMMMMMMMMMMM",
    " ,dxkkok00o,:cllllllcc:,:,,..                          .    ...,,:cloodddoooloolllll:clllclllclllco8MMMMMMMMMMMMW",
    "  ckkddoodccccllllclc::,,,.,                                     .,:llollooollllloolllllllllllllcccdO8NNWWMMMMMMM",
    "  .ldoooollclclllccc,,.,...                                        .:llooolollllllllcclcllllllllcc:ldkx08WMMMMMWN",
    "   .looollclcllccc:,  .                                             .:lloollllllccllccllcccclclcc:,,:clk0NMMMMMMN",
    "    ,lollllclcc:::.                                                  ,clllcclccllcccccllccllclcc,lc,,,:d0NWMMMMMM",
    "     ,llllclcccc:,                                                   :clcc:clccllllllllclcllcccc:kW80x0OO8NMMMMMM",
    "      :llolcccc::.                     . ....                        ,clllclclcc:ccccclcclclclcc:c8WWNN8OO88NWMWW",
    "       :llllccc:,                                       ...          .cclllccccccccclccccclcccllc:c0NWNNNN88NNNN8",
    "        ,lllcccc,                              .. ...,::::,,,....  ..:cclc:ccc::c:clcccclclcclcllc::xNNNN88NN8NNN",
    "         ,clccc::.                       .  ...,,::clclc:::::,,,,,,,,,cccccccccccccccccclc:ccllllc,:cxNN8N88888O8",
    "          ,clccc:,                     ...,,::cccclclcccccc:::::::::,::::c:cc:cccccccccc::cccllllc.,:l0OO888Oo,",
    "   .      ,lccc:::,..          ..,:::,,,,,,,,,,,,,:ccccccc:::::::::,::::::c::::::cc:ccc,,ccccclcl: .:clxNWWNOl,",
    "         :00kc:c:::,..  . ..... ...,,,,,... ,.,,:,::c:::cccc:c::::,,,,,::c:::ccc::ccc,,,:c:cclclc,  ,ccdOWMMMMWOo",
    "        ,dWWMWk,:::,,,.,.... ...,.,.....,....,,..,,,,:::::::::,:,:,,:,::::,,:::::c::..,:c:ccccccc,  ,cclxNMMMMMMM",
    "    .:dOWMMMMMWc:::c:,,.........,.,.,,,.,.......,..,,::::::::::,,,,:,::,:,::::::c::.,::::::c:cc::   ,::ld0WMMMMMM",
    " ,kNWMMMMMMMMWO..:c:::,,......,...,.,..,.,,.,..,,.,,,,:,::::,:::,:,:,,,,,,:::::::,.,::::::::c:::,   ,::clx8WMMMMM",
    "WMMMMMMMMMMMMWk.  ,:c::,,...,........,.....,..,.,,,,,:,,:::,,:::,,,,:,,,,::::::,.,::,:,:::::::::.   ,,,cld0WWWMMM",
    "MMMMMMMMMMMMMNc    .,::,,,.,...,.,..,.,.,.,.,,,,.,,,:,:,:,:::,,:,,,:,:,,,,:,:,,.,,,::,:::::::::..   .::cookNWWWWM",
    "MMMMMMMMMMMMMN.    .. .,,,,,,,..,.,,.,.,.,.,,.,..,:,:.::,:,:,,,:,:,,,,,:::,,,,:,:::,:,:,::,,:,,.   ...:clod8WWNWN"
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
