package calc

import "testing"

func TestMean(t *testing.T) {
	if got := Mean([]int{1, 2}); got != 1.5 {
		t.Fatalf("Mean([1 2]) = %v, want 1.5", got)
	}
	if got := Mean([]int{1, 2, 3, 4}); got != 2.5 {
		t.Fatalf("Mean([1 2 3 4]) = %v, want 2.5", got)
	}
}

func TestMedian(t *testing.T) {
	if got := Median([]int{4, 1, 3, 2}); got != 2.5 {
		t.Fatalf("Median([4 1 3 2]) = %v, want 2.5", got)
	}
	if got := Median([]int{3, 1, 2}); got != 2 {
		t.Fatalf("Median([3 1 2]) = %v, want 2", got)
	}
}

func TestEmpty(t *testing.T) {
	if got := Mean(nil); got != 0 {
		t.Fatalf("Mean(nil) = %v, want 0", got)
	}
}
