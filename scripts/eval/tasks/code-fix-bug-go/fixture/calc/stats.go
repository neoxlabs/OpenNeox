package calc

import "sort"

func Mean(values []int) float64 {
	if len(values) == 0 {
		return 0
	}
	total := 0
	for _, v := range values {
		total += v
	}
	return float64(total / len(values))
}

func Median(values []int) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return float64(sorted[mid])
	}
	return float64(sorted[mid])
}
