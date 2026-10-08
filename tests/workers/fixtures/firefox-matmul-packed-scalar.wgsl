enable f16;

      struct Uniforms { dim_a_outer:i32, dim_b_outer:i32, dim_inner:i32, batchDims_shape:u32, batchDims_strides:u32, a_shape:vec3<u32>, a_strides:vec3<u32>, b_shape:vec3<u32>, b_strides:vec3<u32>, bias_shape:u32, bias_strides:u32, result_shape:vec3<u32>, result_strides:vec3<u32> };
      @group(0) @binding(4) var<uniform> uniforms: Uniforms;
  fn i2o_a(indices: vec3<u32>) -> u32 {
    return uniforms.a_strides[2] * (indices[2])+uniforms.a_strides[1] * (indices[1])+uniforms.a_strides[0] * (indices[0]);
  }

  fn get_aByIndices(indices: vec3<u32>) -> f32 {
    return a[i2o_a(indices)];
  }

  fn i2o_b(indices: vec3<u32>) -> u32 {
    return uniforms.b_strides[2] * (indices[2])+uniforms.b_strides[1] * (indices[1])+uniforms.b_strides[0] * (indices[0]);
  }

  fn get_bByIndices(indices: vec3<u32>) -> f32 {
    return b[i2o_b(indices)];
  }


  fn i2o_result(indices: vec3<u32>) -> u32 {
    return uniforms.result_strides[2] * (indices[2])+uniforms.result_strides[1] * (indices[1])+uniforms.result_strides[0] * (indices[0]);
  }

  fn set_resultByIndices(indices: vec3<u32>, value: f32) {
    result[i2o_result(indices)]=value;
  }

  @group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read> bias: array<f32>;
@group(0) @binding(3) var<storage, read_write> result: array<f32>;

    fn mm_readA(batch: i32, row: i32, colIn: i32, batchIndices: u32) -> f32 {
      var value = f32(0.0);
      let col = colIn * 1;
      if(row < uniforms.dim_a_outer && col < uniforms.dim_inner)
      {
        var aIndices: vec3<u32>;


      if (uniforms.a_shape[0] != 1) {
        aIndices[0]=batchIndices;
      } else {
        aIndices[0]=0;
      }

        aIndices[1]=u32(row);
        aIndices[2]=u32(colIn);
        value = get_aByIndices(aIndices);
      }
      return value;
    }

    fn mm_readB(batch: i32, row: i32, colIn: i32, batchIndices: u32) -> f32 {
      var value = f32(0.0);
      let col = colIn * 1;
      if(row < uniforms.dim_inner && col < uniforms.dim_b_outer)
      {
        var bIndices: vec3<u32>;


      if (uniforms.b_shape[0] != 1) {
        bIndices[0]=batchIndices;
      } else {
        bIndices[0]=0;
      }

        bIndices[1]=u32(row);
        bIndices[2]=u32(colIn);
        value = get_bByIndices(bIndices);
      }
      return value;
    }

    fn mm_write(batch: i32, row: i32, colIn: i32, valueIn: f32) {
      let col = colIn * 1;
      if (row < uniforms.dim_a_outer && col < uniforms.dim_b_outer) {
        var value = valueIn;
        let coords = vec3<i32>(batch, row, colIn);
        value = value + bias[colIn];

        set_resultByIndices(vec3<u32>(coords), value);
      }
    }



  var<workgroup> mm_Asub : array<array<f32, 32>, 32>;
  var<workgroup> mm_Bsub : array<array<f32, 32>, 32>;
  const rowPerThread = 4;
  const colPerThread = 4;
  const tileInner = 32;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_id) localId : vec3<u32>,
        @builtin(global_invocation_id) globalId : vec3<u32>,
        @builtin(workgroup_id) workgroupId : vec3<u32>) {
    let batch = i32(globalId.z);
    let batchIndices = u32(batch);
    let num_tiles = (uniforms.dim_inner - 1) / tileInner + 1;
    var kStart = 0;

    var acc : array<array<f32, colPerThread>, rowPerThread>;

let tileRow = i32(localId.y) * rowPerThread;
let tileCol = i32(localId.x) * colPerThread;

let globalRow = i32(globalId.y) * rowPerThread;
let globalCol = i32(globalId.x) * colPerThread;
let globalRowStart = i32(workgroupId.y) * 32;

let tileRowA = i32(localId.y) * 4;
let tileColA = i32(localId.x) * 4;
let tileRowB = i32(localId.y) * 4;
// Loop over shared dimension.
for (var t = 0; t < num_tiles; t = t + 1) {
  // Load one tile of A into local memory.
  for (var innerRow = 0; innerRow < 4; innerRow = innerRow + 1) {
    for (var innerCol = 0; innerCol < 4; innerCol = innerCol + 1) {
      let inputRow = tileRowA + innerRow;
      let inputCol = tileColA + innerCol;

            mm_Asub[inputRow][inputCol] = mm_readA(batch,
              globalRowStart + inputRow,
              kStart + inputCol, batchIndices);

    }
  }

  // Load one tile of B into local memory.
  for (var innerRow = 0; innerRow < 4; innerRow = innerRow + 1) {
    for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
      let inputRow = tileRowB + innerRow;
      let inputCol = tileCol + innerCol;
      mm_Bsub[inputRow][inputCol] = mm_readB(batch,
        kStart + inputRow,
        globalCol + innerCol, batchIndices);
    }
  }
  kStart = kStart + tileInner;
  workgroupBarrier();

  // Compute acc values for a single thread.
  var BCached : array<f32, colPerThread>;
  for (var k = 0; k < tileInner; k = k + 1) {
    for (var inner = 0; inner < colPerThread; inner = inner + 1) {
      BCached[inner] = mm_Bsub[k][tileCol + inner];
    }

    for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      let ACached = mm_Asub[tileRow + innerRow][k];
      for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
        acc[innerRow][innerCol] = acc[innerRow][innerCol] + ACached * BCached[innerCol];
      }
    }
  }

  workgroupBarrier();
}

for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
  for (var innerCol = 0; innerCol < colPerThread; innerCol = innerCol + 1) {
    mm_write(batch, globalRow + innerRow, globalCol + innerCol,
        acc[innerRow][innerCol]);
  }
}

  }
