//! Column-oriented rows for Log=4 diagnostics.
//!
//! A 47 h, 1 Hz post-processing log has ~170k rows × ~75 fields. As one JSON map per row that is about 1 GB of
//! Rust memory and most of the parse time; as columns it is a few `Vec<f64>`. JSON callers still see the
//! historical shape: `Table` serializes as an array of row objects, keys in name order (what a `serde_json::Map`
//! row produced). The page receives the columns directly through `wire.rs`.
use serde::{de::Deserializer, ser::SerializeMap, ser::SerializeSeq, Deserialize, Serialize, Serializer};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Data {
    /// NaN means null; every stored number is otherwise finite.
    Numbers(Vec<f64>),
    Text(Vec<Option<String>>),
    /// Mixed columns, kept exactly.
    Values(Vec<Value>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Column {
    pub name: String,
    pub data: Data,
}

/// One value written into a row.
pub enum Cell<'a> {
    Number(f64),
    Null,
    Text(&'a str),
    Other(Value),
}

#[derive(Clone, Debug, Default)]
pub struct Table {
    rows: usize,
    columns: Vec<Column>,
    index: HashMap<String, usize>,
}

impl Data {
    fn len(&self) -> usize {
        match self {
            Data::Numbers(v) => v.len(),
            Data::Text(v) => v.len(),
            Data::Values(v) => v.len(),
        }
    }
    fn value(&self, row: usize) -> Value {
        match self {
            Data::Numbers(v) if v[row].is_nan() => Value::Null,
            Data::Numbers(v) => serde_json::json!(v[row]),
            Data::Text(v) => v[row].as_ref().map_or(Value::Null, |s| Value::String(s.clone())),
            Data::Values(v) => v[row].clone(),
        }
    }
    fn into_values(self) -> Vec<Value> {
        let len = self.len();
        (0..len).map(|i| self.value(i)).collect()
    }
    fn push(&mut self, cell: Cell) {
        match (&mut *self, cell) {
            (Data::Numbers(v), Cell::Number(x)) => v.push(x),
            (Data::Numbers(v), Cell::Null) => v.push(f64::NAN),
            (Data::Text(v), Cell::Text(s)) => v.push(Some(s.into())),
            (Data::Text(v), Cell::Null) => v.push(None),
            (Data::Values(v), cell) => v.push(match cell {
                Cell::Number(x) => serde_json::json!(x),
                Cell::Null => Value::Null,
                Cell::Text(s) => Value::String(s.into()),
                Cell::Other(x) => x,
            }),
            (Data::Numbers(v), Cell::Text(s)) if v.iter().all(|x| x.is_nan()) => {
                let mut text = vec![None; v.len()];
                text.push(Some(s.into()));
                *self = Data::Text(text);
            }
            (_, cell) => {
                *self = Data::Values(std::mem::replace(self, Data::Numbers(vec![])).into_values());
                self.push(cell);
            }
        }
    }
    fn pop(&mut self) {
        match self {
            Data::Numbers(v) => drop(v.pop()),
            Data::Text(v) => drop(v.pop()),
            Data::Values(v) => drop(v.pop()),
        }
    }
    fn split_off(&mut self, at: usize) -> Data {
        match self {
            Data::Numbers(v) => Data::Numbers(v.split_off(at)),
            Data::Text(v) => Data::Text(v.split_off(at)),
            Data::Values(v) => Data::Values(v.split_off(at)),
        }
    }
}

impl Table {
    pub fn len(&self) -> usize {
        self.rows
    }
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// Index of a column, created and back-filled with nulls when it first appears.
    pub fn column(&mut self, name: &str) -> usize {
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        self.columns.push(Column { name: name.into(), data: Data::Numbers(vec![f64::NAN; self.rows]) });
        self.index.insert(name.into(), self.columns.len() - 1);
        self.columns.len() - 1
    }

    /// Set a value of the row being built; a second write to the same column replaces the first.
    pub fn put(&mut self, column: usize, cell: Cell) {
        let data = &mut self.columns[column].data;
        if data.len() > self.rows {
            data.pop();
        }
        data.push(cell);
    }

    /// Finish the row being built; columns it did not set become null, as an absent key reads in the page.
    pub fn end_row(&mut self) {
        self.rows += 1;
        for c in &mut self.columns {
            if c.data.len() < self.rows {
                c.data.push(Cell::Null);
            }
        }
    }

    /// Order columns by name, the key order of the historical `serde_json::Map` rows.
    pub fn sort_columns(&mut self) {
        self.columns.sort_by(|a, b| a.name.cmp(&b.name));
        self.index = self.columns.iter().enumerate().map(|(i, c)| (c.name.clone(), i)).collect();
    }

    pub fn retain_tail(&mut self, keep: usize) {
        if self.rows > keep {
            let at = self.rows - keep;
            for c in &mut self.columns {
                c.data = c.data.split_off(at);
            }
            self.rows = keep;
        }
    }

    #[cfg(test)]
    pub fn get(&self, row: usize, name: &str) -> Value {
        self.index.get(name).map_or(Value::Null, |&i| self.columns[i].data.value(row))
    }

    pub fn from_rows(rows: &[Value]) -> Self {
        let mut table = Table::default();
        for row in rows {
            if let Value::Object(map) = row {
                for (key, value) in map {
                    let i = table.column(key);
                    table.put(
                        i,
                        match value {
                            Value::Null => Cell::Null,
                            Value::Number(n) => n.as_f64().map_or(Cell::Null, Cell::Number),
                            Value::String(s) => Cell::Text(s),
                            other => Cell::Other(other.clone()),
                        },
                    );
                }
            }
            table.end_row();
        }
        table.sort_columns();
        table
    }
}

impl Serialize for Table {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        struct Row<'a>(&'a Table, usize);
        impl Serialize for Row<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.columns.len()))?;
                for c in &self.0.columns {
                    map.serialize_entry(&c.name, &c.data.value(self.1))?;
                }
                map.end()
            }
        }
        let mut seq = serializer.serialize_seq(Some(self.rows))?;
        for i in 0..self.rows {
            seq.serialize_element(&Row(self, i))?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for Table {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Table::from_rows(&Vec::<Value>::deserialize(deserializer)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rows_round_trip_through_columns_including_text_and_mixed_values() {
        let rows = serde_json::json!([
            {"Obs": 31, "Ratio": null, "time": "2026-10-01T00:00:00.000Z", "Note": "a"},
            {"Obs": 30.5, "Ratio": 2.5, "time": "2026-10-01T00:00:01.000Z", "Note": 4},
            {"Obs": null, "time": "2026-10-01T00:00:02.000Z", "Extra": "x"}
        ]);
        let table = Table::from_rows(rows.as_array().unwrap());
        assert_eq!(table.len(), 3);
        assert_eq!(
            table.columns().iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["Extra", "Note", "Obs", "Ratio", "time"]
        );
        assert!(matches!(table.columns()[1].data, Data::Values(_)));
        assert!(matches!(table.columns()[4].data, Data::Text(_)));
        let back = serde_json::to_value(&table).unwrap();
        assert_eq!(back[0]["Obs"].as_f64(), Some(31.));
        assert_eq!(back[1]["Note"].as_f64(), Some(4.));
        assert_eq!(back[0]["Note"], "a");
        // An absent key reads as null, which the page treats the same as a missing value.
        assert!(back[2]["Ratio"].is_null() && back[0]["Extra"].is_null());
        let again = serde_json::from_value::<Table>(back.clone()).unwrap();
        assert_eq!(serde_json::to_value(&again).unwrap(), back);
    }
    #[test]
    fn rows_can_be_replaced_and_trimmed() {
        let mut t = Table::default();
        for i in 0..5 {
            let c = t.column("v");
            t.put(c, Cell::Number(i as f64));
            t.put(c, Cell::Number(i as f64 * 10.));
            t.end_row();
        }
        t.retain_tail(2);
        assert_eq!(t.len(), 2);
        assert_eq!(t.get(0, "v"), serde_json::json!(30.));
        assert_eq!(t.columns()[0].data, Data::Numbers(vec![30., 40.]));
        assert_eq!(t.get(1, "v"), serde_json::json!(40.));
    }
}
