// Deliberately infinite synchronous JS loop. The embedded QuickJS interrupt
// handler must stop it instead of leaving NativeThree-Game.exe in Task Manager.
let counter = 0;
while (true) counter++;
