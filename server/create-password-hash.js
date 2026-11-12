import { stdin, stdout } from "node:process";
import bcrypt from "bcryptjs";

if (!stdin.isTTY || !stdin.setRawMode) throw new Error("Run this command from an interactive terminal.");
stdin.setEncoding("utf8");
stdin.setRawMode(true);
stdin.resume();
stdout.write("Dashboard password (minimum 12 characters; input hidden): ");
let password = "";
let finished = false;
const cleanup = () => {
  stdin.removeListener("data", onData);
  stdin.setRawMode(false);
  stdin.pause();
};
const onData = async (input) => {
  if (finished) return;
  for (const character of input) {
    if (character === "\u0003") {
      finished = true;
      cleanup();
      stdout.write("\nPassword generation cancelled.\n");
      process.exitCode = 1;
      return;
    }
    if (character === "\r" || character === "\n") {
      finished = true;
      cleanup();
      stdout.write("\n");
      if (password.length < 12) {
        console.error("The password must contain at least 12 characters.");
        process.exitCode = 1;
      } else {
        console.log(await bcrypt.hash(password, 12));
      }
      return;
    }
    if (character === "\u007f" || character === "\b") {
      password = Array.from(password).slice(0, -1).join("");
    } else {
      password += character;
    }
  }
};
stdin.on("data", onData);
process.on("exit", cleanup);
}
