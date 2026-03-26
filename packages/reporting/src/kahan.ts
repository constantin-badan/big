export class KahanSum {
  private sum = 0;
  private compensation = 0;

  add(value: number): void {
    const y = value - this.compensation;
    const t = this.sum + y;
    this.compensation = (t - this.sum) - y;
    this.sum = t;
  }

  get value(): number {
    return this.sum;
  }

  reset(): void {
    this.sum = 0;
    this.compensation = 0;
  }
}
