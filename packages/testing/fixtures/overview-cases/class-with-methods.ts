export class Greeter {
  greet(name: string): string {
    return `Hello, ${name}`;
  }

  shout(name: string): string {
    return this.greet(name).toUpperCase();
  }
}
