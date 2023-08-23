const puppeteer = require('puppeteer');

function delay(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}


(async () => {
  // variables to play with on how fast we process game state and act on it
  const delayBetweenActionGroups = 40; //25-50 works well in my experience
  const iterationDelay = 500; // 150-500 lower delays work better on easier levels, for hard and above no 300+ already was able to play the game for hours

  // Set this to be the difficulty you want to play as. Options "Easy", "Normal", "Hard", "Harder", "Insane" - TODO -make this an argument or somehow dynamic otherwise
  const desiredDifficulty = "Easy";


  // Launch the browser and show it
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  // Set screen size to match the game "native" size
  await page.setViewport({ width: 1280, height: 720 });

  // Navigate the page to the game
  await page.goto('https://plbrault.github.io/youre-the-os/', { waitUntil: 'networkidle0' });

  let nrCpus = 4;
  let nrRamRows = 5;

  // select the correct difficulty and start the game
  switch (desiredDifficulty) {
    case "Easy":
      await page.mouse.click(560, 430);
      nrRamRows = 8;
      break;
    case "Hard":
      await page.mouse.click(710, 430);
      nrCpus = 8;
      nrRamRows = 6;
      break;
    case "Harder":
      await page.mouse.click(710, 430);
      await delay(20);
      await page.mouse.click(710, 430);
      nrCpus = 12;
      nrRamRows = 6;
      break;
    case "Insane":
      await page.mouse.click(710, 430);
      await delay(20);
      await page.mouse.click(710, 430);
      await delay(20);
      await page.mouse.click(710, 430);
      nrCpus = 16;
      nrRamRows = 4;
      break;
  }
  // click on play
  await delay(20);
  await page.mouse.click(640, 500);


  // take a screenshot after loading delay...
  await delay(500);
  await page.screenshot({ path: 'game_start.png' });

  let gameState;

  while (true) {
    gameState = await getState(page, nrCpus, nrRamRows);

    // end the loop once it is game over
    if (gameState.isGameOver) {
      break;
    }

    // press the IO button
    if (gameState.hasIO) {
      await page.mouse.click(50, 10);
    }

    //empty the not used ram (if we need to add other pages in)
    if (gameState.ramPagesToMove.length > 0) {
      for (let clickInstruction of gameState.ramPagesToMove) {
        await page.mouse.click(clickInstruction.x, clickInstruction.y);
      }
      await delay(delayBetweenActionGroups);
    }

    //move pages from disk to ram (if needed)
    if (gameState.diskPagesToMove.length > 0) {
      for (let clickInstruction of gameState.diskPagesToMove) {
        await page.mouse.click(clickInstruction.x, clickInstruction.y);
      }
      await delay(delayBetweenActionGroups);
    }

    //remove processes from cpu
    if (gameState.cpuClickList.length > 0) {
      for (let clickInstruction of gameState.cpuClickList) {
        await page.mouse.click(clickInstruction.x, clickInstruction.y);
      }
      await delay(delayBetweenActionGroups);
    }

    //add proccesses to empty cpus
    for (let clickInstruction of gameState.processClickList) {
      await page.mouse.click(clickInstruction.x, clickInstruction.y);
    }

    await delay(iterationDelay);
  }


  console.log('GG');
  await page.screenshot({ path: 'highscore.png' });
  await delay(5000);
  await browser.close();
})();


async function getState(page, nrCpus, nrRamRows) {
  return await page.evaluate((nrCpus, nrRamRows) => {
    // map colors to priority, higher priority will be put to cpu sooner
    const colorToPriorityMap = {
      "0,0,0": 0,
      "155,155,154": 0,
      "0,255,0": 1,
      "255,255,0": 2,
      "255,165,0": 3,
      "255,0,0": 4,
      "139,0,0": 5,
      "80,0,0": 6
    }

    function prioritySort(a, b) {
      if (a.priority > b.priority) {
        return -1;
      }
      else {
        return b.priority > a.priority ? 1 : 0;
      }
    }


    function getPixelFromContext(context, x, y) {
      const imageData = context.getImageData(x, y, 1, 1);
      return imageData.data.slice(0, 3).join(",");
    }

    const cpuClickList = [];
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("2d");

    //get end game pixel
    const isGameOver = getPixelFromContext(context, 950, 699) === "255,255,255";

    // get io button color
    const hasIO = getPixelFromContext(context, 50, 10) === "0,128,128";


    //get cpu states
    let nrProcessesToAdd = 0;
    const cpuColors = [];
    for (let i = 0; i < nrCpus; i++) {
      cpuColors[i] = getPixelFromContext(context, 91 + i * 69, 91);
      if (cpuColors[i] === "155,155,154" || cpuColors[i] === "0,255,0" || cpuColors[i] === "176,216,230") {
        cpuClickList.push({ x: 91 + i * 69, y: 91 });
        nrProcessesToAdd++;
      }
      if (cpuColors[i] === "0,0,0") {
        nrProcessesToAdd++;
      }
    }


    //get processes state
    const processes = [];
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 7; column++) {
        const color = getPixelFromContext(context, 91 + column * 69, 196 + row * 69);
        const priority = colorToPriorityMap[color];


        if (priority > 0) {
          processes.push({
            x: 91 + column * 69,
            y: 196 + row * 69,
            priority
          })
        }
      }
    }

    //get memory stats (TODO - handle the case when not enough free memory is in ram for all the processes and therefore no swap is possible by just removing not currently used pages)
    const diskStartY = 155 + (nrRamRows + 1) * 37 + 7;
    const diskRowsY = []
    for (let i = 0; i < 11 - nrRamRows; i++) {
      diskRowsY.push(diskStartY + i * 37);
    }

    // check how many slots we need free (count pages on disk that are needed)
    const diskPagesToMove = [];
    for (let y of diskRowsY) {
      for (let i = 0; i < 16; i++) {
        const x = 589 + i * 41;
        const color = getPixelFromContext(context, x, y);
        if (color === "255,255,255" || color === "0,0,255") {
          diskPagesToMove.push({ x, y });
        }
      }
    }

    const minFreePagesNeeded = diskPagesToMove.length;
    let nrFreeRamPages = 0;
    let notUsedRamPages = [];
    if (minFreePagesNeeded > 0) {
      //look for empty and not used pages in ram
      for (let row = 0; row < nrRamRows && nrFreeRamPages < minFreePagesNeeded; row++) {
        for (let column = 0; column < 16; column++) {
          const x = 589 + column * 41;
          const y = 155 + row * 37;

          const color = getPixelFromContext(context, x, y);
          if (color === "0,0,0") {
            nrFreeRamPages++;
          }

          //if we already have enough free slots found, no need to look further
          if (nrFreeRamPages >= minFreePagesNeeded) {
            break;
          }

          if (color === "99,102,106") {
            notUsedRamPages.push({ x, y });
          }
        }
      }
    }


    return {
      isGameOver,
      hasIO,
      cpuClickList,
      processClickList: processes.sort(prioritySort).slice(0, nrProcessesToAdd),
      ramPagesToMove: notUsedRamPages.slice(0, minFreePagesNeeded - nrFreeRamPages),
      diskPagesToMove,
    };
  }, nrCpus, nrRamRows);
}
